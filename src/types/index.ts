export type MessageStatus = "pending" | "parsed" | "error";

export type LineEventType =
  | "message"
  | "follow"
  | "unfollow"
  | "join"
  | "leave"
  | "memberJoined"
  | "memberLeft"
  | "postback"
  | "beacon"
  | "accountLink"
  | "unsend"
  | "videoPlayComplete";

export type LineMessageType =
  | "text"
  | "image"
  | "video"
  | "audio"
  | "file"
  | "location"
  | "sticker"
  | "imagemap"
  | "template"
  | "flex";

export type LineSourceType = "user" | "group" | "room";

export interface RawEvent {
  id: string;
  event_id: string;
  destination: string;
  event_type: LineEventType;
  message_type: LineMessageType | null;
  source_type: LineSourceType;
  source_id: string;
  user_id: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

export interface ParsedMessage {
  id: string;
  raw_event_id: string;
  parser_name: string;
  parser_version: string;
  parsed_data: Record<string, unknown>;
  status: MessageStatus;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  raw_event?: RawEvent;
}

export interface DashboardStats {
  total_events: number;
  parsed_count: number;
  pending_count: number;
  error_count: number;
  events_today: number;
}

export interface PaginatedResult<T> {
  data: T[];
  count: number;
  page: number;
  pageSize: number;
  totalPages: number;
}
