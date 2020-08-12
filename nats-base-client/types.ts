/*
 * Copyright 2020 The NATS Authors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
//@ts-ignore
import { NatsConnection } from "./nats.ts";
import { NatsError } from "./mod.ts";
import { MsgHdrs } from "./headers.ts";
import { Authenticator } from "./authenticator.ts";

export const Empty = new Uint8Array(0);

export const Events = Object.freeze({
  DISCONNECT: "disconnect",
  RECONNECT: "reconnect",
  UPDATE: "update",
  LDM: "ldm",
});

export interface Status {
  type: string;
  data: string | ServersChanged;
}

export const DebugEvents = Object.freeze({
  RECONNECTING: "reconnecting",
  PING_TIMER: "pingTimer",
  STALE_CONNECTION: "staleConnection",
});

export const DEFAULT_PORT = 4222;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_HOSTPORT = `${DEFAULT_HOST}:${DEFAULT_PORT}`;

// DISCONNECT Parameters, 2 sec wait, 10 tries
export const DEFAULT_RECONNECT_TIME_WAIT = 2 * 1000;
export const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;
export const DEFAULT_JITTER = 100;
export const DEFAULT_JITTER_TLS = 1000;

// Ping interval
export const DEFAULT_PING_INTERVAL = 2 * 60 * 1000; // 2 minutes
export const DEFAULT_MAX_PING_OUT = 2;

export interface ConnectFn {
  (opts: ConnectionOptions): Promise<NatsConnection>;
}

export interface NatsConnection {
  closed(): Promise<void | Error>;
  close(): Promise<void>;
  publish(subject: string, data?: Uint8Array, options?: PublishOptions): void;
  subscribe(subject: string, opts?: SubscriptionOptions): Subscription;
  request(
    subject: string,
    data?: Uint8Array,
    opts?: RequestOptions,
  ): Promise<Msg>;
  flush(): Promise<void>;
  drain(): Promise<void>;
  isClosed(): boolean;
  isDraining(): boolean;
  getServer(): string;
  status(): AsyncIterable<Status>;
}

export interface ConnectionOptions {
  authenticator?: Authenticator;
  debug?: boolean;
  headers?: boolean;
  maxPingOut?: number;
  maxReconnectAttempts?: number;
  name?: string;
  noEcho?: boolean;
  noRandomize?: boolean;
  noResponders?: boolean;
  pass?: string;
  pedantic?: boolean;
  pingInterval?: number;
  port?: number;
  reconnect?: boolean;
  reconnectDelayHandler?: () => number;
  reconnectJitter?: number;
  reconnectJitterTLS?: number;
  reconnectTimeWait?: number;
  servers?: Array<string> | string;
  timeout?: number;
  tls?: TlsOptions;
  token?: string;
  user?: string;
  verbose?: boolean;
  waitOnFirstConnect?: boolean;
}

// these may not be supported on all environments
export interface TlsOptions {
  certFile?: string;
  caFile?: string;
  keyFile?: string;
}

export interface Msg {
  subject: string;
  sid: number;
  reply?: string;
  data: Uint8Array;
  headers?: MsgHdrs;

  respond(data?: Uint8Array, headers?: MsgHdrs): boolean;
}

export interface SubscriptionOptions {
  queue?: string;
  max?: number;
  timeout?: number;
  callback?: (err: NatsError | null, msg: Msg) => void;
}

export interface Base {
  subject: string;
  callback: (error: NatsError | null, msg: Msg) => void;
  received: number;
  timeout?: number | null;
  max?: number | undefined;
  draining: boolean;
}

export interface ServerInfo {
  tls_required?: boolean;
  tls_verify?: boolean;
  connect_urls?: string[];
  max_payload: number;
  client_id: number;
  headers?: boolean;
  proto: number;
  server_id: string;
  version: string;
  echo?: boolean;
  nonce?: string;
  nkey?: string;
}

export interface ServersChanged {
  readonly added: string[];
  readonly deleted: string[];
}

export interface Subscription extends AsyncIterable<Msg> {
  unsubscribe(max?: number): void;
  drain(): Promise<void>;
  isDraining(): boolean;
  isClosed(): boolean;
  callback(err: NatsError | null, msg: Msg): void;
  getSubject(): string;
  getReceived(): number;
  getProcessed(): number;
  getID(): number;
  getMax(): number | undefined;
}

export interface RequestOptions {
  timeout: number;
  headers?: MsgHdrs;
  noMux?: boolean;
}

export interface PublishOptions {
  reply?: string;
  headers?: MsgHdrs;
}