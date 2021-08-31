/*
 * Copyright 2021 The NATS Authors
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

import {
  AckPolicy,
  ConsumerConfig,
  ConsumerInfo,
  DeliverPolicy,
  DiscardPolicy,
  Empty,
  JetStreamClient,
  JetStreamManager,
  JetStreamPublishOptions,
  JetStreamSubscription,
  JsMsg,
  Nanos,
  NatsConnection,
  PurgeOpts,
  PurgeResponse,
  RetentionPolicy,
  StorageType,
  StoredMsg,
  StreamConfig,
} from "./types.ts";
import { JetStreamClientImpl } from "./jsclient.ts";
import {
  createInbox,
  headers,
  isFlowControlMsg,
  isHeartbeatMsg,
  millis,
  nanos,
  toJsMsg,
} from "./mod.ts";
import { JetStreamManagerImpl } from "./jsm.ts";
import { checkJsError } from "./jsutil.ts";
import { isNatsError } from "./error.ts";
import { QueuedIterator, QueuedIteratorImpl } from "./queued_iterator.ts";
import { deferred } from "./util.ts";
import { parseInfo } from "./jsmsg.ts";

export interface Entry {
  bucket: string;
  key: string;
  value: Uint8Array;
  created: Date;
  seq: number;
  delta?: number;
  "origin_cluster"?: string;
  operation: "PUT" | "DEL";
}

export interface KvCodec<T> {
  encode(k: T): T;
  decode(k: T): T;
}

export interface KvCodecs {
  key: KvCodec<string>;
  value: KvCodec<Uint8Array>;
}

export function Base64KeyCodec(): KvCodec<string> {
  return {
    encode(key: string): string {
      return btoa(key);
    },
    decode(bkey: string): string {
      try {
        return atob(bkey);
      } catch (err) {
        console.error("died decoding", bkey);
        throw err;
      }
    },
  };
}

export function NoopKvCodecs(): KvCodecs {
  return {
    key: {
      encode(k: string): string {
        return k;
      },
      decode(k: string): string {
        return k;
      },
    },
    value: {
      encode(v: Uint8Array): Uint8Array {
        return v;
      },
      decode(v: Uint8Array): Uint8Array {
        return v;
      },
    },
  };
}

export interface KvStatus {
  bucket: string;
  values: number;
  history: number;
  ttl: Nanos;
  cluster?: string;
  backingStore: StorageType;
}

export interface BucketOpts {
  replicas: number;
  history: number;
  timeout: number;
  maxBucketSize: number;
  maxValueSize: number;
  placementCluster: string;
  mirrorBucket: string;
  ttl: number; // millis
  streamName: string;
  codec: KvCodecs;
}

export function defaultBucketOpts(): Partial<BucketOpts> {
  return {
    replicas: 1,
    history: 1,
    timeout: 2000,
    maxBucketSize: -1,
    maxValueSize: -1,
    codec: NoopKvCodecs(),
  };
}

export interface PutOptions {
  previousSeq: number;
}

export const kvOriginClusterHdr = "KV-Origin-Cluster";
export const kvOperationHdr = "KV-Operation";
const kvPrefix = "KV_";
const kvSubjectPrefix = "$KV";

const validKeyRe = /^[-/=.\w]+$/;
const validSearchKey = /^[-/=.>*\w]+$/;
const validBucketRe = /^[-\w]+$/;

export interface RoKV {
  get(k: string): Promise<Entry | null>;
  history(opts?: { key?: string }): Promise<QueuedIterator<Entry>>;
  watch(opts?: { key?: string }): Promise<QueuedIterator<Entry>>;
  close(): Promise<void>;
  status(): Promise<KvStatus>;
  keys(): Promise<string[]>;
}

export interface KV extends RoKV {
  put(k: string, data: Uint8Array, opts?: Partial<PutOptions>): Promise<number>;
  delete(k: string): Promise<void>;
  purge(opts?: PurgeOpts): Promise<PurgeResponse>;
  destroy(): Promise<boolean>;
}

// this exported for tests
export function validateKey(k: string) {
  if (k.startsWith(".") || k.endsWith(".") || !validKeyRe.test(k)) {
    throw new Error(`invalid key: ${k}`);
  }
}

export function validateSearchKey(k: string) {
  if (k.startsWith(".") || k.endsWith(".") || !validSearchKey.test(k)) {
    throw new Error(`invalid key: ${k}`);
  }
}

export function hasWildcards(k: string) {
  if (k.startsWith(".") || k.endsWith(".")) {
    throw new Error(`invalid key: ${k}`);
  }
  const chunks = k.split(".");

  let hasWildcards = false;
  for (let i = 0; i < chunks.length; i++) {
    switch (chunks[i]) {
      case "*":
        hasWildcards = true;
        break;
      case ">":
        if (i !== chunks.length - 1) {
          throw new Error(`invalid key: ${k}`);
        }
        hasWildcards = true;
        break;
      default:
        // continue
    }
  }
  return hasWildcards;
}

// this exported for tests
export function validateBucket(name: string) {
  if (!validBucketRe.test(name)) {
    throw new Error(`invalid bucket name: ${name}`);
  }
}

export class Bucket implements KV {
  jsm: JetStreamManager;
  js: JetStreamClient;
  stream!: string;
  bucket: string;
  codec!: KvCodecs;
  _prefixLen: number;

  constructor(bucket: string, jsm: JetStreamManager, js: JetStreamClient) {
    validateBucket(bucket);
    this.jsm = jsm;
    this.js = js;
    this.bucket = bucket;
    this._prefixLen = 0;
  }

  static async create(
    nc: NatsConnection,
    name: string,
    opts: Partial<BucketOpts> = {},
  ): Promise<KV> {
    validateBucket(name);
    const to = opts.timeout || 2000;
    const jsm = await nc.jetstreamManager({ timeout: to });
    const bucket = new Bucket(name, jsm, nc.jetstream({ timeout: to }));
    await bucket.init(opts);
    return bucket;
  }

  async init(opts: Partial<BucketOpts> = {}): Promise<void> {
    const bo = Object.assign(defaultBucketOpts(), opts) as BucketOpts;
    this.codec = bo.codec;
    const sc = {} as StreamConfig;
    this.stream = sc.name = opts.streamName ?? this.bucketName();
    sc.subjects = [this.subjectForBucket()];
    sc.retention = RetentionPolicy.Limits;
    sc.max_msgs_per_subject = bo.history;
    sc.max_bytes = bo.maxBucketSize;
    sc.max_msg_size = bo.maxValueSize;
    sc.storage = StorageType.File;
    sc.discard = DiscardPolicy.Old;
    sc.num_replicas = bo.replicas;
    if (bo.ttl) {
      sc.max_age = nanos(bo.ttl);
    }

    try {
      await this.jsm.streams.info(sc.name);
    } catch (err) {
      if (err.message === "stream not found") {
        await this.jsm.streams.add(sc);
      }
    }
  }

  bucketName(): string {
    return this.stream ?? `${kvPrefix}${this.bucket}`;
  }

  subjectForBucket(): string {
    return `${kvSubjectPrefix}.${this.bucket}.>`;
  }

  subjectForKey(k: string): string {
    return `${kvSubjectPrefix}.${this.bucket}.${k}`;
  }

  get prefixLen(): number {
    if (this._prefixLen === 0) {
      this._prefixLen = `${kvSubjectPrefix}.${this.bucket}.`.length;
    }
    return this._prefixLen;
  }

  encodeKey(key: string): string {
    const chunks: string[] = [];
    for (const t of key.split(".")) {
      switch (t) {
        case ">":
        case "*":
          chunks.push(t);
          break;
        default:
          chunks.push(this.codec.key.encode(t));
          break;
      }
    }
    return chunks.join(".");
  }

  decodeKey(ekey: string): string {
    const chunks: string[] = [];
    for (const t of ekey.split(".")) {
      switch (t) {
        case ">":
        case "*":
          chunks.push(t);
          break;
        default:
          chunks.push(this.codec.key.decode(t));
          break;
      }
    }
    return chunks.join(".");
  }

  validateKey = validateKey;

  validateSearchKey = validateSearchKey;

  hasWildcards = hasWildcards;

  close(): Promise<void> {
    return Promise.resolve();
  }

  smToEntry(key: string, sm: StoredMsg): Entry {
    return {
      bucket: this.bucket,
      key: key,
      value: sm.data,
      delta: 0,
      created: sm.time,
      seq: sm.seq,
      origin_cluster: sm.header.get(kvOriginClusterHdr),
      operation: sm.header.get(kvOperationHdr) === "DEL" ? "DEL" : "PUT",
    };
  }

  jmToEntry(k: string, jm: JsMsg): Entry {
    const key = this.decodeKey(jm.subject.substring(this.prefixLen));
    const e = {
      bucket: this.bucket,
      key: key,
      value: jm.data,
      created: new Date(millis(jm.info.timestampNanos)),
      seq: jm.seq,
      origin_cluster: jm.headers?.get(kvOriginClusterHdr),
      operation: jm.headers?.get(kvOperationHdr) === "DEL" ? "DEL" : "PUT",
    } as Entry;

    if (k !== ">") {
      e.delta = jm.info.pending;
    }
    return e;
  }

  async put(
    k: string,
    data: Uint8Array,
    opts: Partial<PutOptions> = {},
  ): Promise<number> {
    const ek = this.encodeKey(k);
    this.validateKey(ek);

    const ji = this.js as JetStreamClientImpl;
    const cluster = ji.nc.info?.cluster ?? "";
    const h = headers();
    h.set(kvOriginClusterHdr, cluster);
    const o = { headers: h } as JetStreamPublishOptions;
    if (opts.previousSeq) {
      o.expect = {};
      o.expect.lastSubjectSequence = opts.previousSeq;
    }
    const pa = await this.js.publish(this.subjectForKey(ek), data, o);
    return pa.seq;
  }

  async get(k: string): Promise<Entry | null> {
    const ek = this.encodeKey(k);
    this.validateKey(ek);
    try {
      const sm = await this.jsm.streams.getMessage(this.bucketName(), {
        last_by_subj: this.subjectForKey(ek),
      });
      return this.smToEntry(k, sm);
    } catch (err) {
      if (err.message === "no message found") {
        return null;
      }
      throw err;
    }
  }

  async delete(k: string): Promise<void> {
    const ek = this.encodeKey(k);
    this.validateKey(ek);
    const ji = this.js as JetStreamClientImpl;
    const cluster = ji.nc.info?.cluster ?? "";
    const h = headers();
    h.set(kvOriginClusterHdr, cluster);
    h.set(kvOperationHdr, "DEL");
    await this.js.publish(this.subjectForKey(ek), Empty, { headers: h });
  }

  consumerOn(k: string, history = false): Promise<ConsumerInfo> {
    const ek = this.encodeKey(k);
    this.validateSearchKey(k);

    const ji = this.js as JetStreamClientImpl;
    const nc = ji.nc;
    const inbox = createInbox(nc.options.inboxPrefix);
    const opts: Partial<ConsumerConfig> = {
      "deliver_subject": inbox,
      "deliver_policy": history
        ? DeliverPolicy.All
        : DeliverPolicy.LastPerSubject,
      "ack_policy": AckPolicy.Explicit,
      "filter_subject": this.subjectForKey(ek),
      "flow_control": true,
    };
    return this.jsm.consumers.add(this.stream, opts);
  }

  async history(opts: { key?: string } = {}): Promise<QueuedIterator<Entry>> {
    const k = opts.key ?? ">";
    const ci = await this.consumerOn(k, true);
    const max = ci.num_pending;
    const qi = new QueuedIteratorImpl<Entry>();
    if (max === 0) {
      qi.stop();
      return qi;
    }
    const ji = this.jsm as JetStreamManagerImpl;
    const nc = ji.nc;
    const subj = ci.config.deliver_subject!;
    const sub = nc.subscribe(subj, {
      callback: (err, msg) => {
        if (err === null) {
          err = checkJsError(msg);
        }
        if (err) {
          if (isNatsError(err)) {
            qi.stop(err);
          }
        } else {
          if (isFlowControlMsg(msg) || isHeartbeatMsg(msg)) {
            msg.respond();
            return;
          }
          qi.received++;
          const jm = toJsMsg(msg);
          const e = this.jmToEntry(k, jm);
          qi.push(e);
          jm.ack();
          if (qi.received === max) {
            sub.unsubscribe();
          }
        }
      },
    });
    sub.closed.then(() => {
      qi.stop();
    }).catch((err) => {
      qi.stop(err);
    });

    return qi;
  }

  async watch(opts: { key?: string } = {}): Promise<QueuedIterator<Entry>> {
    const k = opts.key ?? ">";
    const ci = await this.consumerOn(k, false);
    const qi = new QueuedIteratorImpl<Entry>();

    const ji = this.jsm as JetStreamManagerImpl;
    const nc = ji.nc;
    const subj = ci.config.deliver_subject!;

    const sub = nc.subscribe(subj, {
      callback: (err, msg) => {
        if (err === null) {
          err = checkJsError(msg);
        }
        if (err) {
          if (isNatsError(err)) {
            qi.stop(err);
          }
        } else {
          if (isFlowControlMsg(msg) || isHeartbeatMsg(msg)) {
            msg.respond();
            return;
          }
          qi.received++;
          const jm = toJsMsg(msg);
          qi.push(this.jmToEntry(k, jm));
          jm.ack();
        }
      },
    });
    //@ts-ignore
    sub.closed.then(() => {
      qi.stop();
    }).catch((err) => {
      qi.stop(err);
    });

    return qi;
  }

  async keys(): Promise<string[]> {
    const d = deferred<string[]>();
    const keys: string[] = [];
    const ci = await this.consumerOn(">", false);
    if (ci.num_pending === 0) {
      return Promise.resolve(keys);
    }
    const ji = this.jsm as JetStreamManagerImpl;
    const nc = ji.nc;
    const subj = ci.config.deliver_subject!;
    const sub = nc.subscribe(subj);
    await (async () => {
      for await (const m of sub) {
        const err = checkJsError(m);
        if (err) {
          sub.unsubscribe();
          d.reject(err);
        } else if (isFlowControlMsg(m) || isHeartbeatMsg(m)) {
          m.respond();
        } else {
          const jm = toJsMsg(m);
          const key = this.decodeKey(jm.subject.substring(this.prefixLen));
          keys.push(key);
          m.respond();
          const info = parseInfo(m.reply!);
          if (info.pending === 0) {
            sub.unsubscribe();
            d.resolve(keys);
          }
        }
      }
    })();
    return d;
  }

  purge(opts?: PurgeOpts): Promise<PurgeResponse> {
    return this.jsm.streams.purge(this.bucketName(), opts);
  }

  destroy(): Promise<boolean> {
    return this.jsm.streams.delete(this.bucketName());
  }

  async status(): Promise<KvStatus> {
    const ji = this.js as JetStreamClientImpl;
    const cluster = ji.nc.info?.cluster ?? "";
    const si = await this.jsm.streams.info(this.bucketName());
    return {
      bucket: this.bucketName(),
      values: si.state.messages,
      history: si.config.max_msgs_per_subject,
      ttl: si.config.max_age,
      bucket_location: cluster,
      backingStore: si.config.storage,
    } as KvStatus;
  }
}