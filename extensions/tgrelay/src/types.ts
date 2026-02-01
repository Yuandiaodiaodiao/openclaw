/**
 * Telegram-compatible types for the relay channel.
 * These mirror the Telegram Bot API types for compatibility.
 */

export type TgrelayUser = {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

export type TgrelayChat = {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
  is_forum?: boolean;
};

export type TgrelayMessageEntity = {
  type:
    | "mention"
    | "hashtag"
    | "cashtag"
    | "bot_command"
    | "url"
    | "email"
    | "phone_number"
    | "bold"
    | "italic"
    | "underline"
    | "strikethrough"
    | "spoiler"
    | "code"
    | "pre"
    | "text_link"
    | "text_mention"
    | "custom_emoji";
  offset: number;
  length: number;
  url?: string;
  user?: TgrelayUser;
  language?: string;
  custom_emoji_id?: string;
};

export type TgrelayPhotoSize = {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
};

export type TgrelayDocument = {
  file_id: string;
  file_unique_id: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
  thumb?: TgrelayPhotoSize;
};

export type TgrelayAudio = {
  file_id: string;
  file_unique_id: string;
  duration: number;
  performer?: string;
  title?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

export type TgrelayVideo = {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  duration: number;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
};

export type TgrelayVoice = {
  file_id: string;
  file_unique_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
};

export type TgrelaySticker = {
  file_id: string;
  file_unique_id: string;
  type: "regular" | "mask" | "custom_emoji";
  width: number;
  height: number;
  is_animated?: boolean;
  is_video?: boolean;
  emoji?: string;
  set_name?: string;
};

export type TgrelayLocation = {
  longitude: number;
  latitude: number;
  horizontal_accuracy?: number;
  live_period?: number;
  heading?: number;
  proximity_alert_radius?: number;
};

export type TgrelayMessage = {
  message_id: number;
  message_thread_id?: number;
  from?: TgrelayUser;
  sender_chat?: TgrelayChat;
  date: number;
  chat: TgrelayChat;
  forward_from?: TgrelayUser;
  forward_from_chat?: TgrelayChat;
  forward_from_message_id?: number;
  forward_signature?: string;
  forward_sender_name?: string;
  forward_date?: number;
  is_topic_message?: boolean;
  reply_to_message?: TgrelayMessage;
  text?: string;
  entities?: TgrelayMessageEntity[];
  caption?: string;
  caption_entities?: TgrelayMessageEntity[];
  photo?: TgrelayPhotoSize[];
  document?: TgrelayDocument;
  audio?: TgrelayAudio;
  video?: TgrelayVideo;
  voice?: TgrelayVoice;
  sticker?: TgrelaySticker;
  location?: TgrelayLocation;
};

export type TgrelayCallbackQuery = {
  id: string;
  from: TgrelayUser;
  message?: TgrelayMessage;
  inline_message_id?: string;
  chat_instance: string;
  data?: string;
  game_short_name?: string;
};

export type TgrelayUpdate = {
  update_id: number;
  message?: TgrelayMessage;
  edited_message?: TgrelayMessage;
  channel_post?: TgrelayMessage;
  edited_channel_post?: TgrelayMessage;
  callback_query?: TgrelayCallbackQuery;
};

// Outbound types (for sending replies)
export type TgrelayOutboundMessage = {
  method: "sendMessage" | "sendPhoto" | "sendDocument" | "sendAudio" | "sendVideo" | "sendVoice";
  chat_id: number | string;
  text?: string;
  caption?: string;
  parse_mode?: "HTML" | "Markdown" | "MarkdownV2";
  reply_to_message_id?: number;
  message_thread_id?: number;
  disable_notification?: boolean;
  reply_markup?: {
    inline_keyboard?: Array<
      Array<{
        text: string;
        callback_data?: string;
        url?: string;
      }>
    >;
  };
  // For media
  photo?: string; // URL or file_id
  document?: string;
  audio?: string;
  video?: string;
  voice?: string;
};

// Config types
export type TgrelayAccountConfig = {
  enabled?: boolean;
  name?: string;
  webhookPath?: string;
  inboundSecret?: string;
  outboundUrl?: string;
  outboundHeaders?: Record<string, string>;
  botUsername?: string;
  dm?: {
    policy?: "open" | "allowlist" | "pairing" | "disabled";
    allowFrom?: Array<string | number>;
  };
  groupPolicy?: "open" | "allowlist" | "disabled";
  groupAllowFrom?: Array<string | number>;
  groups?: Record<
    string,
    {
      enabled?: boolean;
      allow?: boolean;
      requireMention?: boolean;
      users?: Array<string | number>;
      systemPrompt?: string;
    }
  >;
  requireMention?: boolean;
  mediaMaxMb?: number;
};
