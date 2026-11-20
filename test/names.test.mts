// The names module on its own: no database, no keys.
import { Names, isPlaceholder, numberLabel } from '../src/store/names.ts';

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ' -> ' + JSON.stringify(detail)}`); if (!ok) failed++; };

const pid = (j: string) => `p:${j}`;
const A = '966501111111@s.whatsapp.net', B = '966502222222@s.whatsapp.net', C = '966503333333@s.whatsapp.net', G = '1203@g.us';
const n = new Names({
  chats: new Map([[pid(A), { jid: A, name: 'Noura (chat)', group: 0 }], [pid(G), { jid: G, name: 'Team', group: 1 }], [pid(C), { jid: C, name: '+966 50∙∙∙∙33', group: 0, push: 'Cee' }]]),
  contacts: new Map([[pid(A), { jid: A, name: 'Noura', notify: 'N' }], [pid(B), { jid: B, notify: 'Bee' }]]),
  customs: new Map([[pid(B), 'Bandar']]),
}, pid);

check('placeholders are not names', isPlaceholder('+966 50∙∙∙∙33') && isPlaceholder('0501234') && isPlaceholder('') && !isPlaceholder('Dana'));
check('numbers read as +digits, lid too', numberLabel(A) === '+966501111111' && numberLabel('123@lid') === '+123' && numberLabel(G) === G);
check('the chat name wins for a chat', n.chat(A).name === 'Noura (chat)');
check('a saved name beats a display name', n.chat(B).name === 'Bandar');
check('a masked chat name falls through to the push name', n.chat(C).name === 'Cee');
check('nobody known reads as the number', JSON.stringify(n.chat('966509999999@s.whatsapp.net')) === JSON.stringify({ name: '+966509999999', numberOnly: true }));
check('a sender is named the same way as their chat', n.sender({ fromMe: false, sender: pid(B) }).name === n.chat(B).name);
check('me is Me', n.sender({ fromMe: true, sender: 'me' }).me === true);
check('a stranger with a push name shows it', n.sender({ fromMe: false, sender: pid('x@s.whatsapp.net'), push: 'Pushy' }).name === 'Pushy');
const anon = n.sender({ fromMe: false, sender: pid('966507777777@s.whatsapp.net'), jid: '966507777777@s.whatsapp.net' });
check('a stranger with nothing is their number, flagged', anon.name === '+966507777777' && anon.numberOnly);

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
