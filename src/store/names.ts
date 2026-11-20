/**
 * Who a chat or a person is, as a name to show. One ranking for chats and for senders, so a person reads the same
 * in their own chat, in a group and in a search hit.
 *
 * Built from a decrypted snapshot of the small tables (chats, contacts, saved names). Knows nothing about SQL or keys:
 * the store hands it the snapshot and the function that turns a jid into its stored pseudonym.
 */

export interface ChatRec { jid: string; name?: string | null; group: 0 | 1; push?: string; pushTs?: number }
export interface ContactRec { jid: string; name?: string | null; notify?: string | null }

/** The decrypted small tables, keyed by pseudonym. */
export interface NameSources { chats: Map<string, ChatRec>; contacts: Map<string, ContactRec>; customs: Map<string, string> }

/** A name to show, and whether it is really just the number (nobody named them). */
export interface Name { name: string; numberOnly: boolean }

/** WhatsApp names chats it has no contact for after the number, sometimes masked ("+972∙∙∙∙∙∙∙20"). That is a placeholder, not a name. */
export const isPlaceholder = (name?: string | null) => !name || /∙/.test(name) || /^[\d\s+-]*$/.test(name);
const real = (x?: string | null) => (isPlaceholder(x) ? null : (x as string));

/** A jid as a phone number people recognise: "+966501234567". Ids that aren't a phone number come back as they are. */
export function numberLabel(jid: string): string {
  const m = jid.match(/^(\d+)@(s\.whatsapp\.net|lid)$/);
  return m ? `+${m[1]}` : jid;
}

export class Names {
  constructor(private src: NameSources, private pid: (jid: string) => string) {}

  /**
   * Best first: the name WhatsApp gave the chat (a group's subject, or the contact name on a direct chat), the contact
   * name, a name the owner saved, the person's own display name, then the last display name seen in their messages.
   */
  private ranked(cid: string, extraPush?: string | null): string | null {
    const ch = this.src.chats.get(cid), ct = this.src.contacts.get(cid);
    return real(ch?.name) ?? real(ct?.name) ?? this.src.customs.get(cid) ?? real(ct?.notify) ?? real(ch?.push) ?? real(extraPush) ?? null;
  }

  /** A chat, direct or group. */
  chat(jid: string): Name {
    const name = this.ranked(this.pid(jid));
    return name ? { name, numberOnly: false } : { name: numberLabel(jid), numberOnly: true };
  }

  /**
   * Whoever sent a message. `sender` is the stored pseudonym, `jid` and `push` what the message itself recorded
   * (its sender's jid and display name), for people the snapshot knows nothing about.
   */
  sender(m: { fromMe: boolean; sender: string | null; jid?: string; push?: string }): Name & { me: boolean } {
    if (m.fromMe) return { name: 'Me', numberOnly: false, me: true };
    const name = m.sender ? this.ranked(m.sender, m.push) : real(m.push);
    if (name) return { name, numberOnly: false, me: false };
    return { name: m.jid ? numberLabel(m.jid) : 'unknown', numberOnly: true, me: false };
  }
}
