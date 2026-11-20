// WhatsApp messages to events, with no store behind them.
import { translate } from '../src/whatsapp/translate.ts';

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' -> ' + JSON.stringify(detail)}`); if (!ok) failed++; };
const norm = (j?: string | null) => (j ? (j === '99@lid' ? '966500000099@s.whatsapp.net' : j) : null);
const A = '966501111111@s.whatsapp.net', G = '1203@g.us';

const [t] = translate({ key: { id: 'm1', remoteJid: A, fromMe: false }, messageTimestamp: 50, pushName: 'Ali', message: { conversation: 'hi' } } as any, norm);
check('a text is a message event', t.kind === 'message' && t.body === 'hi' && t.senderJid === A && t.push === 'Ali' && t.ts === 50, t);

const [g] = translate({ key: { id: 'm2', remoteJid: G, fromMe: false, participant: '99@lid' }, messageTimestamp: 60, message: { conversation: 'yo' } } as any, norm);
check('a group sender goes through normalisation', g.kind === 'message' && g.senderJid === '966500000099@s.whatsapp.net', g);

const [mine] = translate({ key: { id: 'm3', remoteJid: A, fromMe: true }, messageTimestamp: 70, message: { conversation: 'ok' } } as any, norm);
check('my own message has no sender', mine.kind === 'message' && mine.fromMe && mine.senderJid === null);

const [r] = translate({ key: { id: 'm4', remoteJid: A, fromMe: false }, messageTimestamp: 80, message: { extendedTextMessage: { text: 'yes', contextInfo: { stanzaId: 'm3', quotedMessage: { imageMessage: { caption: 'look' } } } } } } as any, norm);
check('a reply carries what it quotes, media described', r.kind === 'message' && r.quote?.id === 'm3' && r.quote.b === '[image] look', r);

const [re] = translate({ key: { id: 'm5', remoteJid: A, fromMe: true }, messageTimestamp: 90, message: { reactionMessage: { key: { id: 'm1' }, text: '👍', senderTimestampMs: 91000 } } } as any, norm);
check('a reaction is a react event at its own time', re.kind === 'react' && re.target === 'm1' && re.emoji === '👍' && re.ts === 91 && re.fromMe, re);

const hist = translate({ key: { id: 'm6', remoteJid: A, fromMe: false }, messageTimestamp: 100, message: { conversation: 'old' }, reactions: [{ key: { fromMe: true }, text: '❤️', senderTimestampMs: 101000 }] } as any, norm);
check('history reactions ride along with their message', hist.length === 2 && hist[0].kind === 'react' && (hist[0] as any).history && hist[1].kind === 'message', hist);

const [ed] = translate({ key: { id: 'm7', remoteJid: A }, message: { protocolMessage: { key: { id: 'm1' }, editedMessage: { conversation: 'hi there' } } } } as any, norm);
const [del] = translate({ key: { id: 'm8', remoteJid: A }, message: { protocolMessage: { key: { id: 'm1' }, type: 0 } } } as any, norm);
check('edits and deletes', ed.kind === 'edit' && ed.body === 'hi there' && del.kind === 'delete' && del.id === 'm1');

const img = translate({ key: { id: 'm9', remoteJid: A, fromMe: false }, messageTimestamp: 1, message: { imageMessage: { caption: 'c', mediaKey: new Uint8Array([1, 2]), directPath: '/x', mimetype: 'image/jpeg' } } } as any, norm)[0];
check('media keeps what it takes to download it', img.kind === 'message' && img.media?.k === 'image' && img.media.path === '/x' && img.media.rk.remoteJid === A, img);

check('status updates mean nothing', translate({ key: { id: 's', remoteJid: 'status@broadcast' }, message: { conversation: 'x' } } as any, norm).length === 0);
check('plumbing means nothing', translate({ key: { id: 'p', remoteJid: A }, message: { senderKeyDistributionMessage: {} } } as any, norm).length === 0);

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
