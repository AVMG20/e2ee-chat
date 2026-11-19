import { toast } from 'vue-sonner'
import { chat } from '@/lib/chat'
import { openConversation } from '@/lib/nav'
import type { ConvId } from '@/lib/types'

/**
 * Links to a message: <server>/#/m/<conv>/<message id>. They only open for people who have that
 * message (members of the chat); the link itself reveals nothing but the ids.
 */
export function messageLink(conv: ConvId, id: string): string {
  const base = chat.state.account?.server ?? location.origin
  return `${base}/#/m/${encodeURIComponent(conv)}/${encodeURIComponent(id)}`
}

const LINK_RE = /^#\/m\/([^/]+)\/([^/]+)$/

/** The conversation and message a link points to, or null if it isn't a message link of this server. */
export function parseMessageLink(href: string): { conv: ConvId; id: string } | null {
  let url: URL
  try {
    url = new URL(href, location.href)
  } catch {
    return null
  }
  const server = chat.state.account?.server
  if (url.origin !== location.origin && (!server || url.origin !== new URL(server).origin)) return null
  const m = LINK_RE.exec(url.hash)
  if (!m) return null
  try {
    const conv = decodeURIComponent(m[1]!)
    const id = decodeURIComponent(m[2]!)
    if (!/^(dm:[0-9A-Z]{8}|g:[0-9a-f]{32})$/.test(conv) || id.length > 128) return null
    return { conv: conv as ConvId, id }
  } catch {
    return null
  }
}

/**
 * A direct message is "dm:<the other person>" for each side, so a link made by the other person names
 * my own id. Then the chat is the DM with the message's author (ids start with "<author>/"), or, for my
 * own message, whichever DM has it.
 */
async function resolveConv(target: { conv: ConvId; id: string }): Promise<ConvId | null> {
  const has = (id: ConvId) => chat.state.conversations.some((c) => c.id === id)
  const me = chat.state.account?.id
  if (!me || target.conv !== `dm:${me}`) return has(target.conv) ? target.conv : null
  const author = target.id.slice(0, target.id.indexOf('/'))
  if (author && author !== me) return has(`dm:${author}`) ? (`dm:${author}` as ConvId) : null
  for (const c of chat.state.conversations) {
    if (c.kind === 'dm' && (await chat.hasMessage(c.id, target.id))) return c.id
  }
  return null
}

/** Opens the message a link points to. Resolves false (after a toast) if it isn't on this device. */
export async function openMessageLink(target: { conv: ConvId; id: string }): Promise<boolean> {
  const conv = await resolveConv(target)
  if (!conv) {
    toast.error("That message isn't in any of your chats")
    return false
  }
  const ok = await chat.hasMessage(conv, target.id)
  if (!ok) toast.error('That message was deleted or is not on this device')
  await openConversation(conv, ok ? target.id : undefined)
  return ok
}
