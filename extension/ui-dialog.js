// Native dialog keeps keyboard focus inside the confirmation and restores it on close.
let confirmationQueue = Promise.resolve();

export function confirmAction({ title, message, confirmLabel = '确认', danger = false }) {
  const pending = confirmationQueue.then(() => new Promise(resolve => {
    const previousFocus = document.activeElement;
    const dialog = document.createElement('dialog');
    dialog.className = 'ui-dialog';
    const body = document.createElement('div');
    body.className = 'ui-dialog-body';
    const heading = document.createElement('h2');
    heading.id = 'confirmation-title';
    heading.textContent = title;
    const copy = document.createElement('p');
    copy.id = 'confirmation-description';
    copy.textContent = message;
    dialog.setAttribute('aria-labelledby', heading.id);
    dialog.setAttribute('aria-describedby', copy.id);
    body.append(heading, copy);
    const actions = document.createElement('div');
    actions.className = 'ui-dialog-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '取消';
    cancel.autofocus = true;
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = danger ? 'danger-confirm' : 'primary-button';
    confirm.textContent = confirmLabel;
    actions.append(cancel, confirm);
    dialog.append(body, actions);
    let accepted = false;
    cancel.addEventListener('click', () => dialog.close());
    confirm.addEventListener('click', () => { accepted = true; dialog.close(); });
    dialog.addEventListener('close', () => {
      dialog.remove();
      if (previousFocus?.isConnected && !previousFocus.disabled) previousFocus.focus();
      resolve(accepted);
    }, { once: true });
    document.body.append(dialog);
    try { dialog.showModal(); }
    catch { dialog.remove(); resolve(false); }
  }));
  confirmationQueue = pending.catch(() => false);
  return pending;
}
