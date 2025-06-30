// server.js
import express from 'express';
import http from 'http';
import cors from 'cors';
import path from 'path';
import WebSocket, { WebSocketServer } from 'ws';
import twilio from 'twilio';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const twilioWss = new WebSocketServer({ noServer: true });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let frontendSockets = [];

// Serve frontend
app.get('/', (_, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Frontend WebSocket for transcript updates
wss.on('connection', (socket) => {
  console.log('✅ Frontend connected');
  frontendSockets.push(socket);
  socket.on('close', () => {
    frontendSockets = frontendSockets.filter(s => s !== socket);
  });
});

// Outgoing call endpoint
const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);
app.post('/call', async (req, res) => {
  const { to } = req.body;
  try {
    const call = await client.calls.create({
      url: `https://${req.headers.host}/twiml`,
      to,
      from: process.env.TWILIO_NUMBER,
      method: 'POST'
    });
    console.log(`📞 Outgoing call initiated to ${to}`);
    res.json({ success: true, sid: call.sid });
  } catch (error) {
    console.error('❌ Call error:', error);
    res.status(500).json({ error: error.message });
  }
});

// TwiML dynamic generation route
app.post('/twiml', (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();

  const start = response.start();
  start.stream({
    url: `wss://${req.headers.host}/twilio`
  });

  response.say('This is a test call. Speak after the beep.');
  response.pause({ length: 60 });

  console.log('🧾 TwiML returned with streaming and pause');

  res.type('text/xml');
  res.send(response.toString());
});

// WebSocket upgrade routing with socket tracking
const upgradedSockets = new Set();

server.on('upgrade', (req, socket, head) => {
  const pathname = req.url;

  if (pathname === '/twilio') {
    const socketId = socket.remoteAddress + ':' + socket.remotePort;

    if (upgradedSockets.has(socketId)) {
      console.warn(`⚠️ Duplicate upgrade attempt for ${socketId} — closing socket`);
      socket.destroy();
      return;
    }

    upgradedSockets.add(socketId);
    console.log(`🔄 WebSocket upgrade for /twilio from ${socketId}`);

    twilioWss.handleUpgrade(req, socket, head, (ws) => {
      twilioWss.emit('connection', ws, req);
    });
  }
});

// Twilio <Stream> handler
twilioWss.on('connection', (twilioSocket) => {
  console.log('📞 Twilio connected');

  const uv = new WebSocket('wss://api.ultravox.ai/realtime', {
    headers: {
      Authorization: `Bearer ${process.env.ULTRAVOX_TOKEN}`
    }
  });

  uv.on('open', () => {
    console.log('🔗 Ultravox WebSocket opened');

    twilioSocket.on('message', (msg) => {
      console.log('[🎧 Incoming Twilio Msg]', msg);
      try {
        const json = JSON.parse(msg);
        if (json.event === 'media') {
          const audio = Buffer.from(json.media.payload, 'base64');
          uv.send(audio);
          console.log('🔊 Sent audio to Ultravox');
        }
      } catch (err) {
        console.error('❌ Error parsing Twilio msg:', err);
      }
    });

    uv.on('message', (data) => {
      console.log('[🧠 Ultravox Msg]', data);
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'transcript' && parsed.transcript?.text) {
          console.log('📝 Transcript:', parsed.transcript.text);
          frontendSockets.forEach(sock => {
            if (sock.readyState === WebSocket.OPEN) {
              sock.send(JSON.stringify({ text: parsed.transcript.text }));
              console.log('📤 Sent transcript to frontend');
            }
          });
        }
      } catch (err) {
        console.error('❌ Error parsing Ultravox msg:', err);
      }
    });
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
