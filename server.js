import express from 'express';
import http from 'http';
import path from 'path';
import dotenv from 'dotenv';
import cors from 'cors';
import https from 'https';
import WebSocket from 'ws';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let frontendSockets = [];

app.get('/', (_, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

wss.on('connection', (socket) => {
  console.log('✅ Frontend WebSocket connected');
  frontendSockets.push(socket);
  socket.on('close', () => {
    frontendSockets = frontendSockets.filter(s => s !== socket);
  });
});

// ✅ Connect to Ultravox `joinUrl` WebSocket
function connectToUltravoxStream(joinUrl) {
  const ws = new WebSocket(joinUrl);

  ws.on('open', () => {
    console.log('📡 Connected to Ultravox stream');
  });

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'transcription' && msg.text) {
        console.log(`📝 ${msg.speaker || 'User'}: ${msg.text}`);
        frontendSockets.forEach(sock => {
          if (sock.readyState === sock.OPEN) {
            sock.send(JSON.stringify({
              type: 'transcript',
              speaker: msg.speaker || 'user',
              text: msg.text
            }));
          }
        });
      }
    } catch (err) {
      console.error('❌ Ultravox stream error:', err.message);
    }
  });

  ws.on('error', (err) => {
    console.error('❌ WebSocket error:', err.message);
  });

  ws.on('close', () => {
    console.log('🔌 Ultravox stream closed');
  });
}

// ✅ Create call via Ultravox
async function createUltravoxCall(systemPrompt, to) {
  return new Promise((resolve, reject) => {
    const config = {
      systemPrompt,
      model: 'fixie-ai/ultravox',
      temperature: 0.3,
      firstSpeaker: 'FIRST_SPEAKER_AGENT',
      voice: 'dae96454-8512-47d5-9248-f5d8c0916d2e',
      medium: {
        twilio: {
          to,
          from: process.env.TWILIO_NUMBER
        }
      },
      selectedTools: []
    };

    const request = https.request('https://api.ultravox.ai/api/calls', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': process.env.ULTRAVOX_TOKEN
      }
    });

    let data = '';
    request.on('response', res => {
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          console.log('📞 Ultravox call started:', parsed);
          resolve(parsed);
        } catch (err) {
          reject(new Error('Failed to parse Ultravox response'));
        }
      });
    });

    request.on('error', reject);
    request.write(JSON.stringify(config));
    request.end();
  });
}

// ✅ Handle /call
app.post('/call', async (req, res) => {
  const { to } = req.body;

  const systemPrompt = `
You are a helpful recruiter bot calling a candidate. Greet the candidate politely.
Ask about their availability, past driving experience, and interest in the role.
If the candidate asks for a human, say you'll escalate and end the call.
`;

  try {
    const { joinUrl } = await createUltravoxCall(systemPrompt, to);
    if (!joinUrl) throw new Error('Ultravox did not return joinUrl');

    connectToUltravoxStream(joinUrl); // start listening to transcripts
    res.json({ success: true, message: 'Call initiated', joinUrl });
  } catch (err) {
    console.error('❌ Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// WebSocket upgrade
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/frontend') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
import express from 'express';
import http from 'http';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
import { WebSocketServer } from 'ws';
import twilio from 'twilio';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import https from 'https';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = http.createServer(app);

const wss = new WebSocketServer({ noServer: true });       // Frontend
const twilioWss = new WebSocketServer({ noServer: true }); // Twilio

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

let frontendSockets = [];

app.get('/', (_, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// === WebSocket Connections ===
wss.on('connection', (socket) => {
  console.log('✅ Frontend WebSocket connected');
  frontendSockets.push(socket);
  socket.on('close', () => {
    frontendSockets = frontendSockets.filter(s => s !== socket);
  });
});

// === Call Trigger ===
const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);

app.post('/call', async (req, res) => {
  const { to } = req.body;
  console.log(`📞 Triggering call to ${to}...`);

  const ultravoxPayload = {
    systemPrompt: 'You are a helpful assistant.',
    model: 'fixie-ai/ultravox',
    temperature: 0.3,
    firstSpeaker: 'FIRST_SPEAKER_AGENT',
    voice: process.env.ULTRAVOX_VOICE_ID,
    medium: {
      twilio: {} // ✅ Correct usage
    }
  };

  try {
    const joinUrl = await new Promise((resolve, reject) => {
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
            console.log('📞 Ultravox call started:', parsed);
            if (parsed.joinUrl) resolve(parsed.joinUrl);
            else reject(new Error('Ultravox did not return joinUrl'));
          } catch (err) {
            reject(err);
          }
        });
      });

      req.on('error', reject);
      req.write(JSON.stringify(ultravoxPayload));
      req.end();
    });

    const call = await client.calls.create({
      twiml: `<Response><Connect><Stream url="${joinUrl}"/></Connect></Response>`,
      to,
      from: process.env.TWILIO_NUMBER,
      statusCallback: `https://${req.headers.host}/status`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']
    });

    res.json({ success: true, sid: call.sid });
  } catch (err) {
    console.error('❌ Ultravox call error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// === TwiML Endpoint ===
app.post('/twiml', (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();
  const start = response.start();
  start.stream({ url: `wss://${req.headers.host}/twilio` });

  response.say('This is a test call. Speak after the beep.');
  response.pause({ length: 60 });

  res.type('text/xml');
  res.send(response.toString());
});

// === Call Status Webhook ===
app.post('/status', (req, res) => {
  const { CallSid, CallStatus, From, To } = req.body;
  console.log(`📶 Call Status: SID=${CallSid}, From=${From}, To=${To}, Status=${CallStatus}`);

  const payload = {
    type: 'status',
    status: CallStatus,
    sid: CallSid,
    from: From,
    to: To
  };

  frontendSockets.forEach(sock => {
    if (sock.readyState === sock.OPEN) {
      sock.send(JSON.stringify(payload));
    }
  });

  res.sendStatus(200);
});

// === WebSocket Upgrade ===
server.on('upgrade', (req, socket, head) => {
  const pathname = req.url;

  if (pathname === '/twilio') {
    console.log('🔌 Upgrading Twilio WebSocket');
    twilioWss.handleUpgrade(req, socket, head, (ws) => {
      twilioWss.emit('connection', ws, req);
    });
  } else if (pathname === '/frontend') {
    console.log('🔌 Upgrading Frontend WebSocket');
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

// === Transcript Relay from Ultravox Twilio Stream ===
twilioWss.on('connection', (twilioSocket) => {
  console.log('🔁 Twilio media WebSocket connected');
  // You can forward the socket stream to Ultravox SDK here if needed
  // For now, we simulate transcript
  twilioSocket.on('message', (data) => {
    // Simulate live transcript:
    const mockTranscript = {
      type: 'transcript',
      speaker: 'agent',
      text: 'Live audio received...'
    };
    frontendSockets.forEach(sock => {
      if (sock.readyState === sock.OPEN) {
        sock.send(JSON.stringify(mockTranscript));
      }
    });
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
