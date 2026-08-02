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

  static async createChat(characterId, personaId, title = 'New Sesi Roleplay') {
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

  static async addMessage(chatId, role, content, thoughts = '', swipes = []) {
    const now = Date.now();
    const message = {
      id: `msg-${now}-${Math.random().toString(36).substr(2, 4)}`,
      chatId,
      role,
      content,
      thoughts,
      swipeIndex: 0,
      swipes: swipes.length ? swipes : [content],
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

  static async updateMessageSwipes(messageId, swipes, activeIndex, thoughts = '') {
    const message = await db.get('messages', messageId);
    if (!message) return;
    const content = swipes[activeIndex] || message.content;
    message.swipes = swipes;
    message.swipeIndex = activeIndex;
    message.content = content;
    message.thoughts = thoughts;
    await db.put('messages', message);
  }

  static async updateMessageContent(messageId, content) {
    const message = await db.get('messages', messageId);
    if (!message) return;
    const swipes = [...(message.swipes || [message.content])];
    swipes[message.swipeIndex || 0] = content;
    message.content = content;
    message.swipes = swipes;
    await db.put('messages', message);
  }

  static async deleteMessage(messageId) {
    await db.delete('messages', messageId);
  }
}
