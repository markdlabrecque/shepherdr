// Reloading on a new build of the screen (the server says which build it serves), without losing anything.
import type { Chat, Snapshot } from '@shared/types.ts'
import type { UI } from './kernel.ts'

/** The screen reloads when nothing would be lost: not on a call or talking to type, not mid-word, and not while a box
 *  whose text isn't kept (a setting being edited, search) has the focus. What you typed comes back after the reload. */
export function mayReload(ui: UI, o: { holds: number; sinceTyped: number; focused: Element | null }) {
  if (ui.call || ui.dict || o.holds > 0 || o.sinceTyped < 3000) return false
  const box = o.focused?.closest?.('input, textarea, select, [contenteditable=true]')
  return !box || box.hasAttribute('data-kept')
}

/** what comes back after a reload: what of the screen was open, the half-typed texts (kept apart from it), and what it
 *  showed (drawn at once, until the server sends it again) */
export type Kept = Partial<UI> & { text?: Record<string, string>; snap?: Snapshot; chats?: Record<string, Chat> }

// Pi can change its active branch without changing the terminal's address. Neither its transcript
// nor a selected quote should render before the new socket verifies what the terminal is showing.
export function withoutPiHistory(kept: Kept): Kept {
  const pi = new Set(Object.entries(kept.chats ?? {}).filter(([, chat]) => chat.cli === 'pi').map(([key]) => key))
  if (!pi.size) return kept
  const chats = Object.fromEntries(Object.entries(kept.chats ?? {}).filter(([key]) => !pi.has(key)))
  const reply = Object.fromEntries(Object.entries(kept.reply ?? {}).filter(([key]) => !pi.has(key)))
  return { ...kept, chats, reply }
}

/** what of the screen comes back after a reload: half-typed texts, attached files, replies, what was open */
export function keptOf(ui: UI, text: Record<string, string>): Kept {
  return {
    text: Object.fromEntries(Object.entries(text).filter(([, v]) => v)),
    files: Object.fromEntries(Object.entries(ui.files).map(([k, fs]) => [k, fs.filter((f) => f.path)]).filter(([, fs]) => fs.length)),
    reply: ui.reply,
    focus: ui.focus,
    viewer: ui.viewer,
    photo: ui.photo,
    settings: ui.settings,
    term: ui.term,
  }
}

