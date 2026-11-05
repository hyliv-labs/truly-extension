/**
 * Background service worker: the only place key material is ever handled.
 *
 * MV3 tears this worker down after ~30s idle, so nothing durable may live in a
 * module-level variable. Unlocked key material goes to chrome.storage.session
 * (cleared on browser exit, never written to disk) and the auto-lock is driven
 * by chrome.alarms rather than setTimeout, which would die with the worker.
 */

const AUTO_LOCK_ALARM = 'truly:auto-lock';
const AUTO_LOCK_MINUTES = 15;

export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(() => {
    console.info('[truly] installed');
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === AUTO_LOCK_ALARM) {
      void lock();
    }
  });
});

/** Drop all unlocked material. Safe to call when already locked. */
async function lock(): Promise<void> {
  await chrome.storage.session.clear();
  await chrome.alarms.clear(AUTO_LOCK_ALARM);
  console.info('[truly] locked');
}

/** Restart the idle countdown. Called on every authenticated action. */
export async function touchAutoLock(): Promise<void> {
  await chrome.alarms.create(AUTO_LOCK_ALARM, {
    delayInMinutes: AUTO_LOCK_MINUTES,
  });
}
