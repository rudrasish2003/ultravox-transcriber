import express from 'express';
import http from 'http';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
import https from 'https';
import { WebSocketServer } from 'ws';
import twilio from 'twilio';
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

// === WebSocket for frontend ===
wss.on('connection', (socket) => {
  console.log('✅ Frontend WebSocket connected');
  frontendSockets.push(socket);
  socket.on('close', () => {
    frontendSockets = frontendSockets.filter(s => s !== socket);
  });
});

// === Create Ultravox Call ===
async function createUltravoxCall(systemPrompt) {
  return new Promise((resolve, reject) => {
    const payload = {
      systemPrompt,
      model: 'fixie-ai/ultravox',
      temperature: 0.3,
      firstSpeaker: 'FIRST_SPEAKER_AGENT',
      voice:'Mark',
      medium: {
        twilio: {} // required, but `to`/`from` not needed here
      }
    };

    const req = https.request('https://api.ultravox.ai/api/calls', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.ULTRAVOX_TOKEN}`
      }
    });

    let data = '';
    req.on('response', res => {
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.joinUrl) {
            resolve(parsed.joinUrl);
          } else {
            reject(new Error('Ultravox did not return joinUrl'));
          }
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on('error', reject);
    req.write(JSON.stringify(payload));
    req.end();
  });
}

// === Handle Call Trigger ===
const twilioClient = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);

app.post('/call', async (req, res) => {
  const { to } = req.body;
  const prompt = `
You are a recruiter calling a candidate. Greet them politely, ask for availability and experience.
If they want a human, politely end the call and mention escalation.
  `;

  try {
    const joinUrl = await createUltravoxCall(prompt);

    const call = await twilioClient.calls.create({
      twiml: `<Response><Connect><Stream url="${joinUrl}"/></Connect></Response>`,
      to,
      from: process.env.TWILIO_NUMBER,
      statusCallback: `https://${req.headers.host}/status`,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed']
    });

    console.log('📞 Call initiated via Twilio:', call.sid);
    res.json({ success: true, sid: call.sid });
  } catch (err) {
    console.error('❌ Call failed:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// === Call Status Webhook ===
app.post('/status', (req, res) => {
  const { CallSid, CallStatus, From, To } = req.body;
  console.log(`📶 Call Status: SID=${CallSid}, From=${From}, To=${To}, Status=${CallStatus}`);

  const statusPayload = {
    type: 'status',
    status: CallStatus,
    sid: CallSid,
    from: From,
    to: To
  };

  frontendSockets.forEach(sock => {
    if (sock.readyState === sock.OPEN) {
      sock.send(JSON.stringify(statusPayload));
    }
  });

  res.sendStatus(200);
});

// === Upgrade WS connections ===
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
server.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
