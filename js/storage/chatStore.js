/* js/storage/chatStore.js - Multi-Session Chat & Message History CRUD */
import { db } from './db.js';

export class ChatStore {
  static async getChatsByCharacter(characterId) {
    const chats = await db.getByIndex('chats', 'characterId', characterId);
    return chats.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }

  static async getChatById(id) {
    return await db.get('chats', id);
  }

  static async createChat(characterId, personaId, title = 'New Roleplay Session') {
    const now = Date.now();
    const chat = {
      id: `chat-${now}`,
      characterId,
      personaId,
      title,
      createdAt: now,
      updatedAt: now
    };
    await db.put('chats', chat);
    return chat;
  }

  static async updateChatTitle(chatId, title, { manual = false } = {}) {
    const chat = await db.get('chats', chatId);
    if (chat) {
      chat.title = title;
      chat.updatedAt = Date.now();
      if (manual) {
        chat.titleEdited = true;
      }
      await db.put('chats', chat);
    }
  }

  static async forkChat(chatId, uptoMessageId) {
    const originalChat = await db.get('chats', chatId);
    if (!originalChat) {
      throw new Error('Chat asal tidak ditemukan.');
    }

    const messages = await this.getMessages(chatId);
    const cutIndex = messages.findIndex(m => m.id === uptoMessageId);
    if (cutIndex === -1) {
      throw new Error('Pesan tujuan fork tidak ditemukan.');
    }

    const messagesToCopy = messages.slice(0, cutIndex + 1);

    const now = Date.now();
    const newChat = {
      id: `chat-${now}`,
      characterId: originalChat.characterId,
      personaId: originalChat.personaId,
      title: `${originalChat.title} (Fork)`,
      forkedFrom: chatId,
      forkedAt: now,
      createdAt: now,
      updatedAt: now
    };
    await db.put('chats', newChat);

    for (let i = 0; i < messagesToCopy.length; i++) {
      const source = messagesToCopy[i];
      const copy = {
        id: `msg-${now}-${i}-${Math.random().toString(36).substr(2, 4)}`,
        chatId: newChat.id,
        role: source.role,
        content: source.content,
        thoughts: source.thoughts,
        swipeIndex: source.swipeIndex,
        swipes: source.swipes,
        toolTrace: source.toolTrace || [],
        toolSegments: source.toolSegments || [],
        createdAt: source.createdAt
      };
      await db.put('messages', copy);
    }

    return newChat;
  }

  static async deleteChat(chatId) {
    const msgs = await db.getByIndex('messages', 'chatId', chatId);
    for (const m of msgs) {
      await db.delete('messages', m.id);
    }
    await db.delete('chats', chatId);
  }

  /* Messages CRUD */
  static async getMessages(chatId) {
    const msgs = await db.getByIndex('messages', 'chatId', chatId);
    return msgs.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  }

  static async getMessageById(messageId) {
    return await db.get('messages', messageId);
  }

  /**
   * @param {Array} [toolSegments] - optional per-round breakdown of `toolTrace`
   *   (`AgentRunner.run()`'s `segments` return value: `[{text, tools}, ...]`),
   *   letting the UI place an inline "tool used here" marker at the exact point
   *   within `content` a round called a tool, instead of only being able to show
   *   one note below the whole (already-joined) message. Purely additive and
   *   optional - `content`/`toolTrace` keep their existing shape/meaning exactly
   *   as before, since other code (prompt history, editing, forking, search)
   *   depends on those. Same single-current-variation limitation as `thoughts`/
   *   `toolTrace` - not retained per past swipe, see CLAUDE.md.
   */
  static async addMessage(chatId, role, content, thoughts = '', swipes = [], toolTrace = [], toolSegments = []) {
    const now = Date.now();
    const message = {
      id: `msg-${now}-${Math.random().toString(36).substr(2, 4)}`,
      chatId,
      role,
      content,
      thoughts,
      swipeIndex: 0,
      swipes: swipes.length ? swipes : [content],
      toolTrace: toolTrace || [],
      toolSegments: toolSegments || [],
      createdAt: now
    };
    await db.put('messages', message);
    const chat = await db.get('chats', chatId);
    if (chat) {
      chat.updatedAt = now;
      await db.put('chats', chat);
    }
    return message;
  }

  static async updateMessageSwipes(messageId, swipes, activeIndex, thoughts = '', toolTrace = [], toolSegments = []) {
    const message = await db.get('messages', messageId);
    if (!message) return;
    const content = swipes[activeIndex] || message.content;
    message.swipes = swipes;
    message.swipeIndex = activeIndex;
    message.content = content;
    message.thoughts = thoughts;
    message.toolTrace = toolTrace || [];
    message.toolSegments = toolSegments || [];
    await db.put('messages', message);
  }

  static async updateMessageContent(messageId, content) {
    const message = await db.get('messages', messageId);
    if (!message) return;
    const swipes = [...(message.swipes || [message.content])];
    swipes[message.swipeIndex || 0] = content;
    message.content = content;
    message.swipes = swipes;
    // toolSegments records WHERE inside the old text each tool was called -
    // editing the text invalidates those boundaries, so drop them rather than
    // render stale segment text that no longer matches `content`. The flat
    // `toolTrace` (and its single below-message note) is untouched and still
    // valid since it doesn't depend on knowing the internal split.
    message.toolSegments = [];
    await db.put('messages', message);
  }

  /**
   * Deletes a message. Deleting a USER message also cascades to the assistant
   * reply/replies it produced - every assistant message directly following it,
   * up to (not including) the next user message. Leaving those behind orphaned
   * a reply under an unrelated turn, which then also poisoned the next prompt's
   * history. One user turn maps to exactly one assistant message, so this
   * normally removes a single reply.
   * @returns {Promise<number>} how many messages were deleted in total.
   */
  static async deleteMessage(messageId) {
    const message = await db.get('messages', messageId);
    if (!message) return 0;

    // Snapshot ordering BEFORE deleting, so the walk-forward is unaffected by
    // the deletion and is safe against two messages sharing a `createdAt` ms.
    const siblings = await this.getMessages(message.chatId);
    const index = siblings.findIndex(m => m.id === messageId);

    await db.delete('messages', messageId);
    let deleted = 1;

    if (message.role !== 'user' || index === -1) return deleted;

    for (let i = index + 1; i < siblings.length; i++) {
      if (siblings[i].role !== 'assistant') break;
      await db.delete('messages', siblings[i].id);
      deleted++;
    }
    return deleted;
  }
}
