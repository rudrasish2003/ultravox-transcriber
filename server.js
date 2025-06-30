import express from 'express';
import http from 'http';
import cors from 'cors';
import path from 'path';
import dotenv from 'dotenv';
import { WebSocketServer } from 'ws';
import twilio from 'twilio';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import Ultravox from 'ultravox-client';
;

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

// Serve frontend page
app.get('/', (_, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Frontend WebSocket connection
wss.on('connection', (socket) => {
  console.log('✅ Frontend WebSocket connected');
  frontendSockets.push(socket);
  socket.on('close', () => {
    frontendSockets = frontendSockets.filter(s => s !== socket);
  });
});

// Twilio call API
const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);
app.post('/call', async (req, res) => {
  const { to } = req.body;
  try {
    const call = await client.calls.create({
      url: `https://${req.headers.host}/twiml`,
      to,
      from: process.env.TWILIO_NUMBER,
      method: 'POST',
      statusCallback: `https://${req.headers.host}/status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST'
    });
    console.log(`📞 Call initiated to ${to}`);
    res.json({ success: true, sid: call.sid });
  } catch (error) {
    console.error('❌ Call failed:', error);
    res.status(500).json({ error: error.message });
  }
});

// Dynamic TwiML with <Stream>
app.post('/twiml', (req, res) => {
  const VoiceResponse = twilio.twiml.VoiceResponse;
  const response = new VoiceResponse();

  const start = response.start();
  start.stream({ url: `wss://${req.headers.host}/twilio` });

  response.say('This is a test call. Speak after the beep.');
  response.pause({ length: 60 });

  console.log('🧾 TwiML returned with streaming + pause');

  res.type('text/xml');
  res.send(response.toString());
});

// Status Webhook
app.post('/status', (req, res) => {
  const { CallSid, CallStatus, From, To } = req.body;
  console.log('📶 Call Status Webhook Hit');
  console.log(`SID: ${CallSid}, From: ${From}, To: ${To}, Status: ${CallStatus}`);

  const payload = {
    type: 'status',
    status: CallStatus,
    sid: CallSid,
    from: From,
    to: To
  };

  if (frontendSockets.length === 0) {
    console.warn('⚠️ No frontend sockets to send status to');
  } else {
    frontendSockets.forEach(sock => {
      if (sock.readyState === sock.OPEN) {
        sock.send(JSON.stringify(payload));
      }
    });
  }

  res.sendStatus(200);
});

// Handle WebSocket upgrades
server.on('upgrade', (req, socket, head) => {
  const pathname = req.url;

  if (pathname === '/twilio') {
    console.log('🔌 WebSocket upgrade for /twilio');
    twilioWss.handleUpgrade(req, socket, head, (ws) => {
      twilioWss.emit('connection', ws, req);
    });
  } else if (pathname === '/frontend') {
    console.log('🔌 WebSocket upgrade for /frontend');
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

// Twilio <Stream> socket + Ultravox SDK
twilioWss.on('connection', (twilioSocket) => {
  console.log('🔁 Twilio WebSocket connected');

  const session = Ultravox.createSession({
    token: process.env.ULTRAVOX_TOKEN
  });

  session.startStream({
    source: {
      type: 'twilio-media-stream',
      stream: twilioSocket
    }
  });

  session.addEventListener('transcripts', () => {
    const latest = session.transcripts.at(-1);
    if (latest?.text) {
      console.log('📝 Transcript:', latest.text);
      frontendSockets.forEach(sock => {
        if (sock.readyState === sock.OPEN) {
          sock.send(JSON.stringify({ type: 'transcript', text: latest.text }));
          console.log('📤 Sent transcript to frontend');
        }
      });
    }
  });

  session.addEventListener('error', (err) => {
    console.error('❌ Ultravox Session Error:', err);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
