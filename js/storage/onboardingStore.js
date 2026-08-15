/* js/storage/onboardingStore.js - First-run setup wizard completion flag
   ============================================================================
   Single boolean, same `settings` key/value pattern as ThemeStore/MCPStore.
   `app.js`'s init() checks this once at boot to decide whether to show
   js/ui/components/onboardingWizard.js; settingsView.js's Data tab exposes a
   button to clear it again ("Run Setup Wizard Again") so skipping it once
   isn't a one-way door.
   ============================================================================ */
import { db } from './db.js';

const KEY = 'onboardingCompleted';

export class OnboardingStore {
  static async getCompleted() {
    const rec = await db.get('settings', KEY);
    return !!(rec && rec.value === true);
  }

  static async setCompleted(completed) {
    await db.put('settings', { key: KEY, value: !!completed });
  }
}
