import { describe, expect, it } from 'vitest';
import {
  isBackgroundToContentRequest,
  isContentToBackgroundRequest,
  isExtensionRuntimeRequest,
  isPopupRuntimeRequest,
} from './messages';

describe('shared/messages runtime type guards (G3)', () => {
  it('accepts plain own-property messages for their respective planes', () => {
    expect(isPopupRuntimeRequest({ type: 'GET_PAIRING_STATUS' })).toBe(true);
    expect(isExtensionRuntimeRequest({ type: 'UNBIND_ACCOUNT' })).toBe(true);
    expect(isContentToBackgroundRequest({ type: 'GET_PENDING_TAB_TASK' })).toBe(true);
    expect(isExtensionRuntimeRequest({ type: 'CONFIRM_PUBLISHED_URL' })).toBe(true);
    expect(isBackgroundToContentRequest({ type: 'PING_CONTENT' })).toBe(true);
    expect(isBackgroundToContentRequest({ type: 'TAB_URL_CHANGED' })).toBe(true);
  });

  it('rejects prototype-inherited type properties across all message planes', () => {
    const protoPopup = Object.create({ type: 'UNBIND_ACCOUNT' }) as unknown;
    const protoContent = Object.create({ type: 'CONFIRM_PUBLISHED_URL' }) as unknown;
    const protoBgToContent = Object.create({ type: 'PING_CONTENT' }) as unknown;

    expect(isPopupRuntimeRequest(protoPopup)).toBe(false);
    expect(isExtensionRuntimeRequest(protoPopup)).toBe(false);
    expect(isContentToBackgroundRequest(protoContent)).toBe(false);
    expect(isExtensionRuntimeRequest(protoContent)).toBe(false);
    expect(isBackgroundToContentRequest(protoBgToContent)).toBe(false);
  });

  it('rejects array values even when assigned an own type property', () => {
    const arrayPopup = Object.assign([], { type: 'UNBIND_ACCOUNT' }) as unknown;
    const arrayContent = Object.assign([], { type: 'GET_PENDING_TAB_TASK' }) as unknown;
    const arrayBg = Object.assign([], { type: 'INJECT_DRAFT' }) as unknown;

    expect(isPopupRuntimeRequest(arrayPopup)).toBe(false);
    expect(isExtensionRuntimeRequest(arrayPopup)).toBe(false);
    expect(isContentToBackgroundRequest(arrayContent)).toBe(false);
    expect(isExtensionRuntimeRequest(arrayContent)).toBe(false);
    expect(isBackgroundToContentRequest(arrayBg)).toBe(false);
  });
});
