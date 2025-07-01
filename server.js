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
