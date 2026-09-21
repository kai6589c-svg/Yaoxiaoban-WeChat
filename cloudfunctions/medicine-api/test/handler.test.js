"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createApiHandler } = require("../lib/handler");
const { AppError } = require("../lib/errors");

function fixture({
  identity = { OPENID: "openid-secret" },
  serviceError,
} = {}) {
  const claims = new Map();
  const tombstones = new Map();
  let serviceCalls = 0;
  const store = {
    accountIdFor: () => "acct_123",
    ensureAccount: async () => ({ _id: "acct_123", status: "active" }),
    claimIdempotency: async ({ action, requestId, requestHash }) => {
      const id = `${action}|${requestId}`;
      const existing = claims.get(id);
      if (existing?.response)
        return { state: "replay", id, response: existing.response };
      claims.set(id, { requestHash });
      return { state: "claimed", id };
    },
    completeIdempotency: async (id, response) => {
      claims.get(id).response = response;
    },
    findDeletionTombstone: async (_openid, requestId) =>
      tombstones.get(requestId) ?? null,
    createDeletionTombstone: async (_openid, requestId) => {
      const item = { _id: `delete_${requestId}`, state: "processing" };
      tombstones.set(requestId, item);
      return item;
    },
    deleteAccountData: async () => {},
    finishDeletionTombstone: async (id, completedAt) => {
      const requestId = id.replace("delete_", "");
      tombstones.set(requestId, { _id: id, state: "completed", completedAt });
    },
  };
  const service = {
    execute: async (action, payload, context) => {
      serviceCalls += 1;
      if (serviceError) throw serviceError;
      return { action, payload, accountId: context.accountId };
    },
  };
  const logger = { warn() {}, error() {}, log() {} };
  const clock = () => new Date("2026-08-19T00:00:00.000Z");
  const handler = createApiHandler({
    store,
    service,
    compatibilityService: service,
    getIdentity: async () => identity,
    clock,
    logger,
  });
  return { handler, store, tombstones, getServiceCalls: () => serviceCalls };
}

test("没有可信 OPENID 时拒绝请求", async () => {
  const { handler } = fixture({ identity: {} });
  const result = await handler({ action: "profile.list", payload: {} });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "UNAUTHENTICATED");
});

test("接受 CloudBase 自动附加的传输元数据但不从中读取身份", async () => {
  const { handler } = fixture({ identity: { OPENID: "trusted-openid" } });
  const result = await handler({
    action: "profile.list",
    payload: {},
    tcbContext: { environment: "production" },
    userInfo: { openId: "forged-openid", appId: "forged-appid" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.data.accountId, "acct_123");
});

test("拒绝客户端伪造 openid/accountId", async () => {
  const { handler } = fixture();
  const result = await handler({
    action: "profile.list",
    payload: { accountId: "other" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_ARGUMENT");
});

test("写操作强制 requestId", async () => {
  const { handler } = fixture();
  const result = await handler({
    action: "profile.create",
    payload: { displayName: "我", relation: "self" },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "INVALID_ARGUMENT");
});

test("相同写请求重放缓存结果且不重复执行业务", async () => {
  const { handler, getServiceCalls } = fixture();
  const event = {
    action: "profile.create",
    requestId: "request-0001",
    payload: { displayName: "妈妈", relation: "parent" },
  };
  const first = await handler(event);
  const second = await handler(event);
  assert.deepEqual(second, first);
  assert.equal(getServiceCalls(), 1);
});

test("账号删除用独立墓碑保证同 requestId 可安全重试", async () => {
  const { handler, tombstones } = fixture();
  const event = {
    action: "account.delete",
    requestId: "delete-00001",
    payload: {},
  };
  const first = await handler(event);
  const second = await handler(event);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(tombstones.get("delete-00001").state, "completed");
});

test("前端兼容 action 接受 privacyVersion 且无 requestId 时生成短时幂等键", async () => {
  const { handler, getServiceCalls } = fixture();
  const event = {
    action: "upsertProfile",
    privacyVersion: "2026-08-01",
    payload: { name: "爸爸", relation: "parent", color: "#4E8D70" },
  };
  const first = await handler(event);
  const second = await handler(event);
  assert.equal(first.ok, true);
  assert.match(first.requestId, /^compat:/);
  assert.deepEqual(second, first);
  assert.equal(getServiceCalls(), 1);
});

test("前端 deleteAccount 返回 null", async () => {
  const { handler } = fixture();
  const result = await handler({
    action: "deleteAccount",
    privacyVersion: "v1",
    payload: {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.data, null);
});

test("照片兼容接口保留可重试和重新选图错误，幂等重放不改写错误码", async () => {
  for (const code of [
    "MEDIA_UNAVAILABLE",
    "INVALID_MEDIA",
    "INVALID_MEDIA_STATE",
    "MEDIA_NOT_FOUND",
    "MEDIA_UPLOAD_EXPIRED",
    "PAYLOAD_TOO_LARGE",
    "FORBIDDEN",
  ]) {
    const { handler, getServiceCalls } = fixture({
      serviceError: new AppError(code, "照片预检失败"),
    });
    const event = {
      action: "commitMedicationPhoto",
      requestId: `photo-error-${code}`,
      payload: {
        medicationId: "med_photo_owner",
        expectedVersion: 1,
        mediaId: "media_photo_owner",
        fileId: "cloud://test-env/medication-photos/owner/media.jpg",
      },
    };
    const result = await handler(event);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, code);
    assert.deepEqual(await handler(event), result);
    assert.equal(getServiceCalls(), 1);
  }
});

test("照片准备、移除和清理接口保留服务暂不可用错误", async () => {
  for (const action of [
    "prepareMedicationPhoto",
    "removeMedicationPhoto",
    "discardMedicationPhoto",
  ]) {
    const { handler } = fixture({
      serviceError: new AppError("MEDIA_UNAVAILABLE", "照片服务暂时不可用"),
    });
    const result = await handler({
      action,
      requestId: `photo-error-${action}`,
      payload:
        action === "discardMedicationPhoto"
          ? { mediaId: "media_photo_owner", fileId: null }
          : { medicationId: "med_photo_owner", expectedVersion: 1 },
    });
    assert.equal(result.error.code, "MEDIA_UNAVAILABLE");
  }
});

test("照片服务错误返回可关联的 traceId", async () => {
  const { handler } = fixture({
    serviceError: new AppError("MEDIA_UNAVAILABLE", "照片服务暂时不可用"),
  });
  const result = await handler({
    action: "commitMedicationPhoto",
    requestId: "photo-trace-0001",
    payload: {
      medicationId: "med_photo_owner",
      expectedVersion: 1,
      mediaId: "media_photo_owner",
      fileId: "cloud://test-env/medication-photos/owner/media.jpg",
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "MEDIA_UNAVAILABLE");
  assert.match(result.error.traceId, /^[a-f0-9]{16}$/);
  assert.equal(result.requestId, "photo-trace-0001");
});

test("非照片兼容接口继续使用原来的校验错误映射", async () => {
  const { handler } = fixture({
    serviceError: new AppError("PAYLOAD_TOO_LARGE", "请求内容过大"),
  });
  const result = await handler({ action: "bootstrap", payload: {} });
  assert.equal(result.error.code, "VALIDATION");
});

test("照片中转接受 2MiB 原图但其他接口仍限制 64KiB", async () => {
  const { handler } = fixture();
  const payload = {
    medicationId: "med_123",
    expectedVersion: 1,
    mediaId: "media_123",
    base64: Buffer.alloc(2 * 1024 * 1024).toString("base64"),
  };
  const event = {
    action: "uploadMedicationPhoto",
    payload,
    requestId: "relay-test-0001",
  };
  assert.equal((await handler(event)).ok, true);
  assert.equal(
    (await handler({ ...event, action: "saveMedication" })).error.code,
    "PAYLOAD_TOO_LARGE",
  );
  assert.equal(
    (
      await handler({
        ...event,
        payload: {
          ...payload,
          base64: Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64"),
        },
      })
    ).error.code,
    "PAYLOAD_TOO_LARGE",
  );
  assert.equal(
    (
      await handler({
        ...event,
        payload: { ...payload, base64: "not base64!" },
      })
    ).error.code,
    "INVALID_MEDIA",
  );
});

test("照片中转拒绝伪造路径和缺少可信身份", async () => {
  const event = {
    action: "uploadMedicationPhoto",
    requestId: "relay-test-0002",
    payload: {
      medicationId: "med_123",
      expectedVersion: 1,
      mediaId: "media_123",
      base64: "YQ==",
    },
  };
  const { handler } = fixture({ identity: {} });
  assert.equal((await handler(event)).ok, false);
  assert.equal(
    (
      await fixture().handler({
        ...event,
        payload: { ...event.payload, cloudPath: "other/file" },
      })
    ).ok,
    false,
  );
});

test("集中盘点稳定请求 ID 重试只执行一次写入且保留原始盘点时间", async () => {
  const { handler, getServiceCalls } = fixture();
  const event = {
    action: "confirmInventory",
    requestId: "inventory-stable-0001",
    payload: {
      medicationId: "med_test",
      quantityMilli: 4125,
      recordedAt: "2026-08-18T03:00:00.000Z",
      requestId: "inventory-stable-0001",
      note: "集中盘点",
    },
  };
  const first = await handler(event);
  assert.equal(first.ok, true);
  assert.deepEqual(await handler(event), first);
  assert.equal(getServiceCalls(), 1);
  assert.equal(first.data.payload.recordedAt, event.payload.recordedAt);
});
