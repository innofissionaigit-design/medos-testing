/**
 * Whether a visit in the Cashier's view offers "Edit tests": when it has tests to edit, or a handwritten prescription whose tests still have to be entered
 * (a handwritten visit has no tests listed until the Cashier reads them off the picture, so waiting for tests to exist would leave nothing to press).
 */
export const canEditTests = (testLines: number, unreadPictures: number, editing: boolean): boolean => !editing && (testLines > 0 || unreadPictures > 0);
