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

app.get('/', (_, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// === WebSocket Handling ===
frontendWss.on('connection', (socket) => {
  console.log('✅ Frontend WebSocket connected');
  frontendSockets.push(socket);
  socket.on('close', () => {
    frontendSockets = frontendSockets.filter(s => s !== socket);
  });
});

// === Twilio & Ultravox Call Handler ===
const client = twilio(process.env.TWILIO_SID, process.env.TWILIO_AUTH);

app.post('/call', async (req, res) => {
  const { to } = req.body;

  const payload = {
    systemPrompt: `
You are a helpful recruiter bot calling a candidate. Greet the candidate politely.
Ask about their availability, past driving experience, and interest in the role.
If the candidate asks for a human, say you'll escalate and end the call.
`,
    model: 'fixie-ai/ultravox',
    temperature: 0.3,
    firstSpeaker: 'FIRST_SPEAKER_AGENT',
    voice:  'Mark',
    medium: {
      twilio: {
        to,
        from: process.env.TWILIO_NUMBER
      }
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
            console.log('📦 Ultravox response:', parsed);
            if (parsed.joinUrl) resolve(parsed.joinUrl);
            else reject(new Error('Ultravox did not return joinUrl'));
          } catch (err) {
            reject(err);
          }
        });
      });

      req.on('error', reject);
      req.write(JSON.stringify(payload));
      req.end();
    });

    // Create Twilio call
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
    console.error('❌ Call initiation failed:', err.message);
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

// === Twilio Status Webhook ===
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

// === Simulated Transcript Forwarding ===
twilioWss.on('connection', (twilioSocket) => {
  console.log('🔁 Twilio media WebSocket connected');
  twilioSocket.on('message', (data) => {
    const fakeTranscript = {
      type: 'transcript',
      speaker: 'agent',
      text: '🗣️ Receiving audio... (transcript will appear here)'
    };
    frontendSockets.forEach(sock => {
      if (sock.readyState === sock.OPEN) {
        sock.send(JSON.stringify(fakeTranscript));
      }
    });
  });
});

// === Start Server ===
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});
