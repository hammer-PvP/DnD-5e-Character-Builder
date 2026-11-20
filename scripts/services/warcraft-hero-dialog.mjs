// Wait for the outgoing window to leave the modal stack before starting its successor.
export async function heroDialog(options) {
  let closing;
  const buttons = options.buttons.map(button => ({
    ...button,
    callback(event, target, dialog) {
      if (dialog?.rendered) {
        closing = new Promise(resolve => {
          const hook = Hooks.on("closeApplicationV2", app => {
            if (app !== dialog) return;
            Hooks.off("closeApplicationV2", hook);
            resolve();
          });
        });
      }
      return button.callback ? button.callback(event, target, dialog) : button.action;
    }
  }));
  const result = await foundry.applications.api.DialogV2.wait({ ...options, buttons, rejectClose: false });
  await closing;
  return result;
}
