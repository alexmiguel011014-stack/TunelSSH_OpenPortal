import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import closeConfirmationModule from '../close-confirmation.js';

const { attachCloseConfirmation, CLOSE_DIALOG } = closeConfirmationModule;

function setup(response) {
  const app = new EventEmitter();
  const win = new EventEmitter();
  win.isDestroyed = () => false;
  win.close = vi.fn(() => {
    const event = {
      defaultPrevented: false,
      preventDefault: () => (event.defaultPrevented = true),
    };
    win.emit('close', event);
    return event;
  });
  const showMessageBox = vi.fn(() => Promise.resolve({ response }));
  attachCloseConfirmation(win, { app, showMessageBox });
  return { app, win, showMessageBox };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('attachCloseConfirmation', () => {
  it('asks before closing and closes when the user confirms', async () => {
    const { win, showMessageBox } = setup(0);

    const first = win.close();
    expect(first.defaultPrevented).toBe(true);
    expect(showMessageBox).toHaveBeenCalledWith(win, CLOSE_DIALOG);

    await flush();
    expect(win.close).toHaveBeenCalledTimes(2);
    expect(win.close.mock.results[1].value.defaultPrevented).toBe(false);
  });

  it('keeps the window open when the user cancels', async () => {
    const { win, showMessageBox } = setup(1);

    expect(win.close().defaultPrevented).toBe(true);
    await flush();
    expect(win.close).toHaveBeenCalledTimes(1);

    expect(win.close().defaultPrevented).toBe(true);
    expect(showMessageBox).toHaveBeenCalledTimes(2);
  });

  it('asks only once while the dialog is open', () => {
    const { win, showMessageBox } = setup(1);
    win.close();
    win.close();
    expect(showMessageBox).toHaveBeenCalledTimes(1);
  });

  it('does not ask when the app is already quitting or Windows is ending the session', () => {
    for (const trigger of ['before-quit', 'query-session-end', 'session-end']) {
      const { app, win, showMessageBox } = setup(1);
      (trigger === 'before-quit' ? app : win).emit(trigger, {});
      expect(win.close().defaultPrevented).toBe(false);
      expect(showMessageBox).not.toHaveBeenCalled();
    }
  });

  it('stops listening to the app once the window is gone', () => {
    const { app, win } = setup(1);
    expect(app.listenerCount('before-quit')).toBe(1);
    win.emit('closed');
    expect(app.listenerCount('before-quit')).toBe(0);
  });
});
