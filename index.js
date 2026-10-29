const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');
const express = require('express');

// 1. Setup Express Server untuk Koyeb
const app = express();
const PORT = process.env.PORT || 8000;

app.get('/', (req, res) => {
    res.send('WhatsApp Bot Flohan Store is running active 24/7!');
});

app.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
});

// Helper Function: Cek apakah pengirim pesan adalah admin grup
async function isAdmin(sock, groupId, participantJid) {
    try {
        const groupMetadata = await sock.groupMetadata(groupId);
        const participant = groupMetadata.participants.find(p => p.id === participantJid);
        return participant && (participant.admin === 'admin' || participant.admin === 'superadmin');
    } catch (err) {
        console.error('Gagal mengecek status admin:', err);
        return false;
    }
}

// 2. Setup WhatsApp Bot (Baileys)
async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    const sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        printQRInTerminal: true,
        auth: state
    });

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'close') {
            const reason = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log('Koneksi terputus, mencoba menghubungkan ulang...', reason);
            if (reason !== DisconnectReason.loggedOut) {
                startBot();
            } else {
                console.log('Perangkat keluar (Logged out). Hapus folder auth_info_baileys dan scan ulang QR.');
            }
        } else if (connection === 'open') {
            console.log('Bot WhatsApp Flohan Store berhasil terhubung!');
        }
    });

    sock.ev.on('creds.update', saveCreds);

    // 3. Listener Pesan Masuk
    sock.ev.on('messages.upsert', async (chatUpdate) => {
        try {
            const mek = chatUpdate.messages[0];
            if (!mek.message) return;
            if (mek.key.fromMe) return;

            const messageType = Object.keys(mek.message)[0];
            const from = mek.key.remoteJid; // ID Group / Chat
            const sender = mek.key.participant || from; // Pengirim pesan
            const isGroup = from.endsWith('@g.us');

            // Ambil teks pesan
            const body = (messageType === 'conversation') ? mek.message.conversation :
                         (messageType === 'extendedTextMessage') ? mek.message.extendedTextMessage.text : '';

            if (!body) return;

            // --- FITUR A: ANTI-LINK OTOMATIS ---
            const urlRegex = /(https?:\/\/[^\s]+)|(www\.[^\s]+)|([a-zA-Z0-9-]+\.(com|id|net|org|xyz|me|co|io))/gi;
            if (isGroup && urlRegex.test(body)) {
                // Cek apakah pengirim link adalah admin
                const senderIsAdmin = await isAdmin(sock, from, sender);
                
                if (!senderIsAdmin) {
                    // Hapus pesan link
                    await sock.sendMessage(from, { delete: mek.key });
                    // Kirim peringatan teguran
                    await sock.sendMessage(from, { 
                        text: 'jangan kirim link di group ini ya ghufron!!' 
                    });
                    return;
                }
            }

            // --- FITUR B: PERINTAH KHUSUS ADMIN ---
            const args = body.trim().split(/ +/);
            const command = args[0].toLowerCase();

            // Cek apakah pesan diawali dengan perintah bot (.h, .kick, .ping)
            if (['.h', '.kick', '.ping'].includes(command)) {
                if (!isGroup) {
                    await sock.sendMessage(from, { text: 'Perintah ini hanya dapat digunakan di dalam grup!' }, { quoted: mek });
                    return;
                }

                // Cek hak akses admin
                const senderIsAdmin = await isAdmin(sock, from, sender);
                if (!senderIsAdmin) {
                    await sock.sendMessage(from, { 
                        text: 'lu bukan admin!!! jangan seenaknya perintah gw ya nyet!!' 
                    }, { quoted: mek });
                    return;
                }

                // 1. FITUR .ping (Test Koneksi & Kecepatan Respon)
                if (command === '.ping') {
                    const startTime = Date.now();
                    const sentMsg = await sock.sendMessage(from, { text: 'Menghitung kecepatan...' }, { quoted: mek });
                    const latency = Date.now() - startTime;
                    
                    await sock.sendMessage(from, { 
                        text: `Pong! 🏓\nKecepatan Respon: ${latency} ms\nStatus: Lancar Jaya 24/7` 
                    }, { edit: sentMsg.key });
                }

                // 2. FITUR .h (Hide Tag All Member)
                else if (command === '.h') {
                    try {
                        const groupMetadata = await sock.groupMetadata(from);
                        const participants = groupMetadata.participants;
                        const memberJids = participants.map(p => p.id);
                        
                        const customMessage = args.slice(1).join(' ') || 'Panggilan untuk seluruh member!';
                        
                        await sock.sendMessage(from, { 
                            text: customMessage, 
                            mentions: memberJids 
                        }, { quoted: mek });
                    } catch (err) {
                        console.error('Error hidetag:', err);
                        await sock.sendMessage(from, { text: 'Gagal melakukan hide tag.' }, { quoted: mek });
                    }
                }

                // 3. FITUR .kick (Kick Member yang di-tag / di-reply)
                else if (command === '.kick') {
                    let targetJid = null;

                    // Cek apakah mengutip/reply pesan target
                    const quotedMsg = mek.message.extendedTextMessage?.contextInfo?.quotedMessage;
                    const quotedParticipant = mek.message.extendedTextMessage?.contextInfo?.participant;

                    if (quotedParticipant) {
                        targetJid = quotedParticipant;
                    } 
                    // Atau cek jika menggunakan mention langsung (@nomor)
                    else {
                        const mentioned = mek.message.extendedTextMessage?.contextInfo?.mentionedJid;
                        if (mentioned && mentioned.length > 0) {
                            targetJid = mentioned[0];
                        }
                    }

                    if (!targetJid) {
                        await sock.sendMessage(from, { text: 'Harap reply pesan atau tag member yang ingin di-kick dengan perintah .kick' }, { quoted: mek });
                        return;
                    }

                    // Eksekusi kick member dari grup
                    try {
                        await sock.groupParticipantsUpdate(from, [targetJid], 'remove');
                        await sock.sendMessage(from, { text: 'Berhasil mengeluarkan member tersebut dari grup.' });
                    } catch (err) {
                        console.error('Gagal kick member:', err);
                        await sock.sendMessage(from, { text: 'Gagal mengeluarkan member. Pastikan bot sudah berstatus Admin di grup ini!' }, { quoted: mek });
                    }
                }
            }

        } catch (err) {
            console.log('Error handling message:', err);
        }
    });
}

startBot();
