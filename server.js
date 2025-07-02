import express from 'express';
import http from 'http';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
import { WebSocketServer } from 'ws';
import twilio from 'twilio';
import https from 'https';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = http.createServer(app);

const frontendWss = new WebSocketServer({ noServer: true });
const twilioWss = new WebSocketServer({ noServer: true });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

let frontendSockets = [];

const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);

// === ROUTES ===

app.get('/', (_, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/call', async (req, res) => {
  try {
    const { to } = req.body;

    const systemPrompt = `
You are RecruitAI, a professional, polite, and intelligent recruiter assistant from FedEx. You are screening candidates for the Non CDL/L20 position.

If the candidate says:
"I want to talk to a person" or "Transfer me",
then say:
“Absolutely, I’ll bring in my manager to assist you. Please stay on the line.”
Then call the tool "merge_manager".
`;

    const { joinUrl, id: callId } = await createUltravoxCall(systemPrompt);
    if (!joinUrl) throw new Error('joinUrl not received from Ultravox');

    const call = await client.calls.create({
      twiml: `<Response><Connect><Stream url="${joinUrl}"/></Connect></Response>`,
      to,
      from: process.env.TWILIO_NUMBER,
      statusCallback: `https://${req.headers.host}/status`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['completed']
    });

    console.log('✅ Twilio call initiated:', call.sid);
    res.json({ success: true, sid: call.sid, callId });

    pollTranscript(callId, 10000, 3);
  } catch (err) {
    console.error('❌ Error initiating call:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function createUltravoxCall(systemPrompt) {
  const payload = {
    systemPrompt,
    model: 'fixie-ai/ultravox',
    temperature: 0.3,
    firstSpeaker: 'FIRST_SPEAKER_AGENT',
    voice: 'Mark',
    medium: {}, // ✅ must be empty
    selectedTools: [
      {
        temporaryTool: {
          modelToolName: 'merge_manager',
          description: 'Escalate to a human recruiter.',
          dynamicParameters: [],
          http: {
            baseUrlPattern: process.env.MERGE_SERVER_URL || 'https://merge-server.onrender.com/tool-calls',
            httpMethod: 'POST'
          }
        }
      }
    ]
  };

  return new Promise((resolve, reject) => {
    const req = https.request('https://api.ultravox.ai/api/calls', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': process.env.ULTRAVOX_TOKEN
      }
    });

    let data = '';
    req.on('response', res => {
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          console.log('📦 Ultravox response:', parsed);
          if (parsed.joinUrl && parsed.id) {
            resolve(parsed);
          } else {
            reject(new Error('Ultravox did not return required data'));
          }
        } catch (err) {
          reject(new Error('Failed to parse Ultravox response'));
        }
      });
    });

    req.on('error', reject);
    req.write(JSON.stringify(payload));
    req.end();
  });
}

function pollTranscript(callId, interval = 10000, maxTries = 3) {
  let count = 0;
  const poll = setInterval(() => {
    fetchTranscriptAndBroadcast(callId);
    if (++count >= maxTries) clearInterval(poll);
  }, interval);
}

function fetchTranscriptAndBroadcast(callId) {
  const options = {
    hostname: 'api.ultravox.ai',
    path: `/api/calls/${callId}/messages`,
    method: 'GET',
    headers: {
      'X-API-Key': process.env.ULTRAVOX_TOKEN
    }
  };

  const req = https.request(options, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        const messages = parsed?.messages || [];

        messages.forEach(msg => {
          const transcript = {
            type: 'transcript',
            speaker: msg.role,
            text: msg.content
          };

          frontendSockets.forEach(sock => {
            if (sock.readyState === sock.OPEN) {
              sock.send(JSON.stringify(transcript));
            }
          });
        });
      } catch (err) {
        console.error('❌ Error parsing transcript:', err.message);
      }
    });
  });

  req.on('error', (e) => {
    console.error('❌ Error fetching transcript:', e.message);
  });

  req.end();
}

// === WebSocket Upgrades ===

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/twilio') {
    console.log('🔌 Upgrading Twilio WebSocket');
    twilioWss.handleUpgrade(req, socket, head, (ws) => {
      twilioWss.emit('connection', ws, req);
    });
  } else if (req.url === '/frontend') {
    console.log('🔌 Upgrading Frontend WebSocket');
    frontendWss.handleUpgrade(req, socket, head, (ws) => {
      frontendWss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

frontendWss.on('connection', (socket) => {
  console.log('✅ Frontend WebSocket connected');
  frontendSockets.push(socket);
  socket.on('close', () => {
    frontendSockets = frontendSockets.filter(s => s !== socket);
  });
});

twilioWss.on('connection', (twilioSocket) => {
  console.log('🔁 Twilio WebSocket connected');
  twilioSocket.on('message', () => {
    const placeholder = {
      type: 'transcript',
      speaker: 'agent',
      text: '🗣️ Receiving audio...'
    };
    frontendSockets.forEach(sock => {
      if (sock.readyState === sock.OPEN) {
        sock.send(JSON.stringify(placeholder));
      }
    });
  });
});

// === Call Status Handler ===

app.post('/status', (req, res) => {
  const { CallSid, CallStatus, From, To } = req.body;
  console.log(`📶 Call Status: SID=${CallSid}, Status=${CallStatus}`);

  const status = {
    type: 'status',
    sid: CallSid,
    status: CallStatus,
    from: From,
    to: To
  };

  frontendSockets.forEach(sock => {
    if (sock.readyState === sock.OPEN) {
      sock.send(JSON.stringify(status));
    }
  });

  res.sendStatus(200);
});

// === Start Server ===

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
