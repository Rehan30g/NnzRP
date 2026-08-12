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
      id: `chat-${now}-${Math.random().toString(36).substr(2, 5)}`,
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
      id: `chat-${now}-${Math.random().toString(36).substr(2, 5)}`,
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
        images: source.images || [],
        embeds: source.embeds || [],
        swipeMeta: source.swipeMeta || [],
        createdAt: source.createdAt
      };
      await db.put('messages', copy);
    }

    return newChat;
  }

  /**
   * "Compact Chat" - the AI-summarization counterpart to forkChat(). Instead
   * of copying the whole history verbatim (which is exactly what got a
   * session too long to begin with), this keeps the first `keepFirst`
   * messages (the character's opening + earliest scene-setting) AND the last
   * `keepLast` messages (whatever the user/character were just doing, so the
   * new chat can continue the scene naturally right away) as-is, and
   * replaces only the MIDDLE stretch with ONE AI-generated recap message.
   *
   * An earlier version only kept the first `keepFirst` and folded literally
   * everything else - including the newest message - into the summary. That
   * read as "my last message just got deleted": nothing was actually lost
   * from the database (the ORIGINAL chat is always left untouched), but the
   * new chat the user actually continues in had no verbatim trace of what
   * had just happened, only however well (or poorly) the AI's prose summary
   * happened to capture it. Keeping the most recent turns verbatim too fixes
   * that directly instead of relying on summary quality for continuity.
   *
   * The summary text itself is produced by the caller (chatView.js, via
   * ProviderManager, over exactly the middle stretch this method also
   * computes - see `getCompactMiddleRange` below, which chatView.js calls
   * first to build the transcript) - this method only owns the
   * data-shuffling: create the new chat, copy the kept messages on both
   * ends, insert the recap between them.
   * @param {string} originalChatId
   * @param {string} summaryContent - AI-generated recap text (already trimmed).
   * @param {number} [keepFirst=4]
   * @param {number} [keepLast=4]
   * @returns {Promise<object>} the newly created chat record.
   */
  static async createCompactedChat(originalChatId, summaryContent, keepFirst = 4, keepLast = 4) {
    const originalChat = await db.get('chats', originalChatId);
    if (!originalChat) {
      throw new Error('Chat asal tidak ditemukan.');
    }

    const messages = await this.getMessages(originalChatId);
    const keptFirst = messages.slice(0, keepFirst);
    // Math.max guards against the first/last windows overlapping when the
    // chat is barely longer than keepFirst+keepLast - never re-include a
    // message keptFirst already has.
    const keptLast = keepLast > 0 ? messages.slice(Math.max(keepFirst, messages.length - keepLast)) : [];

    const now = Date.now();
    const newChat = {
      id: `chat-${now}-${Math.random().toString(36).substr(2, 5)}`,
      characterId: originalChat.characterId,
      personaId: originalChat.personaId,
      title: `${originalChat.title} (Ringkasan)`,
      compactedFrom: originalChatId,
      compactedAt: now,
      createdAt: now,
      updatedAt: now
    };
    await db.put('chats', newChat);

    // Copies one message into the new chat with a NEW sequential timestamp
    // (rather than keeping its OWN older original createdAt) so
    // getMessages()'s sort-by-createdAt places every copy in the exact
    // relative order passed in here, regardless of how old the originals
    // were - `seq` is just an incrementing counter shared across both
    // keptFirst and keptLast batches below.
    let seq = 0;
    const copyMessage = async (source) => {
      seq += 1;
      await db.put('messages', {
        id: `msg-${now}-${seq}-${Math.random().toString(36).substr(2, 4)}`,
        chatId: newChat.id,
        role: source.role,
        content: source.content,
        thoughts: source.thoughts,
        swipeIndex: source.swipeIndex,
        swipes: source.swipes,
        toolTrace: source.toolTrace || [],
        toolSegments: source.toolSegments || [],
        images: source.images || [],
        embeds: source.embeds || [],
        swipeMeta: source.swipeMeta || [],
        createdAt: now + seq
      });
    };

    // Order: opening messages, then the recap bridging the gap, then the
    // most recent messages - so the new chat reads as a coherent timeline
    // instead of the recap floating disconnected from what it's bridging.
    for (const source of keptFirst) await copyMessage(source);
    await db.put('messages', {
      id: `msg-${now}-summary-${Math.random().toString(36).substr(2, 4)}`,
      chatId: newChat.id,
      role: 'assistant',
      content: summaryContent,
      thoughts: '',
      swipeIndex: 0,
      swipes: [summaryContent],
      toolTrace: [],
      toolSegments: [],
      images: [],
      isSummary: true,
      createdAt: now + (++seq)
    });
    for (const source of keptLast) await copyMessage(source);

    return newChat;
  }

  /**
   * The middle stretch `createCompactedChat` above will summarize (i.e.
   * everything NOT in its keptFirst/keptLast windows) - exposed separately
   * so chatView.js can build the exact same range into a transcript for the
   * AI summarization call before actually calling createCompactedChat(),
   * without either side having to duplicate (and risk drifting out of sync
   * with) the slicing math.
   */
  static getCompactMiddleRange(messages, keepFirst = 4, keepLast = 4) {
    const end = keepLast > 0 ? Math.max(keepFirst, messages.length - keepLast) : messages.length;
    return messages.slice(keepFirst, end);
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
   *   depends on those.
   * @param {Array<string>} [images] - optional base64 `data:` URLs attached to
   *   this message. On a USER message these come from the composer's
   *   image-upload button; on an ASSISTANT message these come from the
   *   builtin view-image tool (js/services/builtinTools.js) actually
   *   fetching something mid-reply, surfaced from AgentRunner's toolTrace so
   *   the user can see what the character just "looked at", not just have it
   *   fed silently to the model.
   * @param {Array<{html:string, title:string}>} [embeds] - optional HTML/CSS/JS
   *   snippets the builtin "Embed HTML" tool (js/services/builtinTools.js)
   *   produced mid-reply, surfaced from AgentRunner's toolTrace the same way
   *   `images` is (see chatView.js's `collectToolEmbeds`). Rendered in a
   *   sandboxed iframe by chatView.js's `messageEmbedsHTML()`.
   *
   * `thoughts`/`toolTrace`/`toolSegments`/`images`/`embeds` all mirror only the
   * currently-active swipe variation on the message's flat fields, but each
   * variation's own copy is additionally kept in `swipeMeta` below, so switching
   * between swipes restores the right one instead of showing blank/stale data.
   */
  static async addMessage(chatId, role, content, thoughts = '', swipes = [], toolTrace = [], toolSegments = [], images = [], embeds = []) {
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
      images: images || [],
      embeds: embeds || [],
      // One entry per swipe variation (index-aligned with `swipes`), so
      // switching BACK to an existing variation later can restore its own
      // thinking/tools/images/embeds instead of showing blank ones - see
      // updateMessageSwipes() below, which is where entries after this
      // first one get added.
      swipeMeta: [{ thoughts: thoughts || '', toolTrace: toolTrace || [], toolSegments: toolSegments || [], images: images || [], embeds: embeds || [] }],
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

  /**
   * Updates which swipe variation is active. Two distinct calling
   * conventions, both used by chatView.js's handleSwipePrev/handleSwipeNext:
   *   - Just SWITCHING between variations that already exist (no new
   *     generation happened) - called with only (messageId, swipes,
   *     activeIndex), leaving thoughts/toolTrace/toolSegments/images/embeds
   *     as `undefined`. In this case they're restored from
   *     `swipeMeta[activeIndex]` (whatever that variation had recorded when
   *     IT was generated) instead of being blanked out.
   *   - REGENERATING a brand new variation - called with that variation's
   *     actual thoughts/toolTrace/etc (even if some are empty strings/arrays,
   *     they're still explicitly passed, not left `undefined`). These get
   *     applied AND recorded into `swipeMeta[activeIndex]` so a later switch
   *     back to this exact variation can restore them too.
   *
   * Fixes a real bug: earlier, switching between EXISTING swipes (prev/next
   * with no new generation) always overwrote thoughts/toolTrace/toolSegments/
   * images/embeds with this function's empty defaults, since the switch-only
   * call site never passed them - so a variation's own thinking block, tool
   * trace, or any embed it had produced visibly vanished the moment you
   * swiped away and back. (The thoughts/toolTrace half of this was already a
   * documented limitation; extending images/embeds onto the same flat-field
   * pattern just made it far more noticeable - a whole interactive embed
   * disappearing reads very differently than lost thinking text.)
   */
  static async updateMessageSwipes(messageId, swipes, activeIndex, thoughts, toolTrace, toolSegments, images, embeds) {
    const message = await db.get('messages', messageId);
    if (!message) return;
    const content = swipes[activeIndex] !== undefined ? swipes[activeIndex] : message.content;
    const swipeMeta = Array.isArray(message.swipeMeta) ? [...message.swipeMeta] : [];

    const hasNewMeta = thoughts !== undefined || toolTrace !== undefined || toolSegments !== undefined || images !== undefined || embeds !== undefined;
    if (hasNewMeta) {
      swipeMeta[activeIndex] = {
        thoughts: thoughts || '',
        toolTrace: toolTrace || [],
        toolSegments: toolSegments || [],
        images: images || [],
        embeds: embeds || []
      };
    }
    // No recorded metadata for this index (switching to a variation that
    // predates swipeMeta existing) falls back to empty - same as the old
    // behavior, not worse; it "self-heals" the moment that variation is ever
    // regenerated again, since hasNewMeta then records it going forward.
    const meta = swipeMeta[activeIndex] || { thoughts: '', toolTrace: [], toolSegments: [], images: [], embeds: [] };

    message.swipes = swipes;
    message.swipeIndex = activeIndex;
    message.content = content;
    message.swipeMeta = swipeMeta;
    message.thoughts = meta.thoughts;
    message.toolTrace = meta.toolTrace;
    message.toolSegments = meta.toolSegments;
    message.images = meta.images;
    message.embeds = meta.embeds;
    await db.put('messages', message);
  }

  static async updateMessageContent(messageId, content) {
    const message = await db.get('messages', messageId);
    if (!message) return;
    const idx = message.swipeIndex || 0;
    const swipes = [...(message.swipes || [message.content])];
    swipes[idx] = content;
    message.content = content;
    message.swipes = swipes;
    // toolSegments records WHERE inside the old text each tool was called -
    // editing the text invalidates those boundaries, so drop them rather than
    // render stale segment text that no longer matches `content`. The flat
    // `toolTrace` (and its single below-message note) is untouched and still
    // valid since it doesn't depend on knowing the internal split.
    message.toolSegments = [];
    // Also clear it in this swipe's OWN recorded metadata (see
    // updateMessageSwipes' swipeMeta) - otherwise switching away to a
    // different variation and back would silently RESTORE the stale
    // pre-edit toolSegments from swipeMeta, undoing this reset.
    const swipeMeta = Array.isArray(message.swipeMeta) ? [...message.swipeMeta] : [];
    if (swipeMeta[idx]) swipeMeta[idx] = { ...swipeMeta[idx], toolSegments: [] };
    message.swipeMeta = swipeMeta;
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
