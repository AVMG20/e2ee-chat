import * as engine from './engine'

export type { ChatState } from './engine'

/** The chat engine API used by the UI. */
export const chat = {
  state: engine.state,
  /** True inside the Tauri desktop app. */
  isDesktop: engine.isDesktop,
  /** Prefill for the server URL field: page origin in the browser, '' on desktop. */
  defaultServer: engine.defaultServer,
  listAccounts: engine.listAccounts,
  /** Generates keys locally, registers, and logs in. Throws Error with a user-facing message. */
  createAccount: engine.createAccount,
  /** Logs in with a saved account. Throws Error with a user-facing message. */
  login: engine.login,
  logout: engine.logout,
  /** Deletes the account's keys and history from this device. */
  forgetAccount: engine.forgetAccount,
  /** Opens a conversation, loads its messages into state.messages, clears unread. */
  open: engine.openConv,
  /** Sends a Tiptap doc to the active conversation. */
  sendText: engine.sendText,
  /** Sends a file/image to the active conversation. Throws if larger than MAX_FILE_BYTES. */
  sendFile: engine.sendFile,
  /** Object URL for a file message's content (cached), or null if unavailable. */
  fileUrl: engine.fileUrl,
  /** Creates a group with me + members and opens it. Returns its conversation id. */
  createGroup: engine.createGroup,
  addMembers: engine.addMembers,
  leaveGroup: engine.leaveGroup,
  /** My own key fingerprint, formatted for display. */
  myFingerprint: engine.myFingerprint,
  setVerified: engine.setVerified,
  /** Accept a contact's changed key (after verifying it with them). */
  trustNewKey: engine.trustNewKey,
}
