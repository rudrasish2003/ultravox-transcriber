import express from 'express';
import http from 'http';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
import { WebSocketServer } from 'ws';
import twilio from 'twilio';
import https from 'https';
import WebSocket from 'ws';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = http.createServer(app);

const wss = new WebSocketServer({ noServer: true });
const twilioWss = new WebSocketServer({ noServer: true });

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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

const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);

// === 🔧 Ultravox API Call ===
async function createUltravoxCall(systemPrompt) {
  return new Promise((resolve, reject) => {
    const config = {
      systemPrompt,
      model: 'fixie-ai/ultravox',
      temperature: 0.3,
      firstSpeaker: 'FIRST_SPEAKER_AGENT',
      voice: 'dae96454-8512-47d5-9248-f5d8c0916d2e',
      medium: { twilio: {} },
      selectedTools: []
    };

    const request = https.request('https://api.ultravox.ai/api/calls', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': process.env.ULTRAVOX_API_KEY
      }
    });

    let data = '';
    request.on('response', res => {
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          console.log('✅ Ultravox response:', parsed);
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

// === 🔌 Connect to joinUrl WebSocket ===
function connectToUltravoxStream(joinUrl) {
  const ws = new WebSocket(joinUrl);

  ws.on('open', () => {
    console.log('📡 Connected to Ultravox joinUrl stream');
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
      console.error('❌ Failed to parse Ultravox stream data:', err.message);
    }
  });

  ws.on('error', (err) => {
    console.error('❌ Ultravox WebSocket error:', err.message);
  });

  ws.on('close', () => {
    console.log('🔌 Ultravox WebSocket closed');
  });
}

// === Call Trigger Endpoint ===
app.post('/call', async (req, res) => {
  const { to } = req.body;

  const systemPrompt = `
You are RecruitBot. Greet the candidate, ask how they're doing, and let them know this call is recorded for job screening purposes.
Ask them about previous driving experience and availability. Escalate to a manager if they request human assistance.
Keep the tone helpful and concise.
`;

  try {
    // Create Ultravox session and get joinUrl
    const { joinUrl } = await createUltravoxCall(systemPrompt);
    if (!joinUrl) throw new Error('No joinUrl from Ultravox');

    connectToUltravoxStream(joinUrl); // connect to joinUrl stream immediately

    const call = await client.calls.create({
      twiml: `<Response><Connect><Stream url="${joinUrl}" /></Connect></Response>`,
      to,
      from: process.env.TWILIO_NUMBER,
      statusCallback: `https://${req.headers.host}/status`,
      statusCallbackEvent: ['completed'],
      statusCallbackMethod: 'POST'
    });

    console.log(`📞 Call initiated to ${to}, SID: ${call.sid}`);
    res.json({ success: true, sid: call.sid });

  } catch (err) {
    console.error('❌ Call setup failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// === Twilio Status Webhook ===
app.post('/status', (req, res) => {
  const { CallSid, CallStatus, From, To } = req.body;
  console.log(`📶 Call status: SID=${CallSid}, From=${From}, To=${To}, Status=${CallStatus}`);

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

// === WebSocket Upgrade Handling ===
server.on('upgrade', (req, socket, head) => {
  const pathname = req.url;

  if (pathname === '/frontend') {
    console.log('🔌 Upgrading frontend socket');
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
