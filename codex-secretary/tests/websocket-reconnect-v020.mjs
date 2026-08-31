import assert from "node:assert/strict";
import {
  socketIsReusable,
  socketNeedsResumeReconnect,
  websocketReconnectDelay,
} from "../app/websocket-reconnect.ts";

assert.equal(socketIsReusable(0), true, "CONNECTING socket must not be replaced");
assert.equal(socketIsReusable(1), true, "OPEN socket must not be replaced");
assert.equal(socketIsReusable(2), false);
assert.equal(socketIsReusable(3), false);
assert.equal(socketIsReusable(undefined), false);

assert.equal(socketNeedsResumeReconnect(undefined), true);
assert.equal(socketNeedsResumeReconnect(0), false, "visibility sync must keep CONNECTING sockets");
assert.equal(socketNeedsResumeReconnect(1), false);
assert.equal(socketNeedsResumeReconnect(2), true);
assert.equal(socketNeedsResumeReconnect(3), true);

assert.equal(websocketReconnectDelay(0, 0), 1_800);
assert.equal(websocketReconnectDelay(1, 0), 3_600);
assert.equal(websocketReconnectDelay(2, 0), 7_200);
assert.equal(websocketReconnectDelay(20, 0), 30_000, "backoff must be capped");
assert.equal(websocketReconnectDelay(20, 0.999_999), 30_499);

console.log("PALM_V020_WEBSOCKET_RECONNECT_OK");
