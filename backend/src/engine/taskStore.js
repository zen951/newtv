/**
 * engine/taskStore.js
 *
 * In-memory task store.
 * Each task holds its EventEmitter, AbortController, status, and results.
 *
 * Exports:
 *   tasks                                          — the underlying Map (used by runner.js)
 *   createTask()                                   — registers a new task, returns { taskId, emitter }
 *   getTask(taskId)                                — retrieves a task by id, or null
 *   cancelTask(taskId)                             — aborts a running/pending task
 *   setPendingCaptcha(taskId, resolve)             — registers a waiting captcha resolver
 *   resolvePendingCaptcha(taskId, token)           — fulfils the waiting captcha promise
 *   setPendingTvboomDone(taskId, resolve, reject)  — registers a waiting TVBoom registration resolver
 *   resolvePendingTvboomDone(taskId)               — signals that the user completed registration
 *   rejectPendingTvboomDone(taskId)                — signals that the user cancelled registration
 */

import { v4 as uuidv4 } from "uuid";
import { EventEmitter } from "events";

export const tasks = new Map();

// Maps taskId → resolve function for the captcha token Promise.
// Populated by the service while it waits; cleared once the token arrives.
const pendingCaptchas = new Map();

// Stores a resolve callback so the captcha route can unblock the service.
export function setPendingCaptcha(taskId, resolve) {
  pendingCaptchas.set(taskId, resolve);
}

// Fulfils the pending captcha promise with the given token. Returns false if none is waiting.
export function resolvePendingCaptcha(taskId, token) {
  const resolve = pendingCaptchas.get(taskId);
  if (!resolve) return false;
  pendingCaptchas.delete(taskId);
  resolve(token);
  return true;
}

// Creates a new task entry and returns its id and emitter.
export function createTask() {
  const taskId = uuidv4();
  const emitter = new EventEmitter();
  emitter.setMaxListeners(20);

  tasks.set(taskId, {
    emitter,
    abortController: new AbortController(),
    status: "pending",
    results: [],
  });

  return { taskId, emitter };
}

// Returns the task for taskId, or null if not found.
export function getTask(taskId) {
  return tasks.get(taskId) ?? null;
}

// Signals the task's AbortController and marks it as cancelling.
export async function cancelTask(taskId) {
  const task = tasks.get(taskId);
  if (!task || !["running", "pending"].includes(task.status)) return;
  task.abortController.abort();
  task.status = "cancelling";
}

// ── TVBoom manual-registration pause/resume ───────────────────────────────────

const pendingTvboomDone = new Map();

// Stores resolve/reject so the route can unblock the waiting service.
export const setPendingTvboomDone = (taskId, resolve, reject) =>
  pendingTvboomDone.set(taskId, { resolve, reject });

// Retrieves and removes the pending entry, then calls fn with it. Returns false if none exists.
const settleTvboom = (taskId, fn) => {
  const entry = pendingTvboomDone.get(taskId);
  if (!entry) return false;
  pendingTvboomDone.delete(taskId);
  fn(entry);
  return true;
};

// Called when the user confirms registration is complete.
export const resolvePendingTvboomDone = (taskId) =>
  settleTvboom(taskId, ({ resolve }) => resolve());

// Called when the user cancels the registration popup.
export const rejectPendingTvboomDone = (taskId) =>
  settleTvboom(taskId, ({ reject }) =>
    reject(new Error("[TVBoom] Registration cancelled by user.")),
  );
