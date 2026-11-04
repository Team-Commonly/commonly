// @ts-nocheck
// An upload opens in the lightbox only from its signed URL. The raw
// `/api/uploads/<file>` path is relative to the app's origin, which serves no
// uploads, so drawing it while the mint is in flight (or after it failed) cost a
// 404 and a broken-image flash. The D215 crawl found it on every artifact.
import React from 'react';
import { act, render, screen } from '@testing-library/react';
import V2Lightbox from '../components/V2Lightbox';
import { getSignedAttachmentUrl } from '../../utils/signedAttachmentUrl';
import getApiBaseUrl from '../../utils/apiBaseUrl';

jest.mock('../../utils/signedAttachmentUrl', () => ({ getSignedAttachmentUrl: jest.fn() }));

const UPLOAD = '/api/uploads/user-1-1793529085897-449593343.png';
const SIGNED = `${getApiBaseUrl()}/api/uploads/user-1-1793529085897-449593343.png?t=signed`;

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

const open = (src) => render(<V2Lightbox images={[{ src, name: 'sheet.png' }]} index={0} onClose={jest.fn()} />);

beforeEach(() => { getSignedAttachmentUrl.mockReset(); });

it('draws no image while the signed URL is minting, then draws the signed one', async () => {
  const mint = deferred();
  getSignedAttachmentUrl.mockReturnValue(mint.promise);
  open(UPLOAD);

  expect(getSignedAttachmentUrl).toHaveBeenCalledWith(UPLOAD);
  expect(screen.queryByRole('img')).toBeNull();
  expect(document.querySelector(`img[src="${UPLOAD}"]`)).toBeNull();

  await act(async () => { mint.resolve(SIGNED); await mint.promise; });
  expect(screen.getByRole('img', { name: 'sheet.png' })).toHaveAttribute('src', SIGNED);
});

it('says the image could not load when signing fails, and never falls back to the raw path', async () => {
  getSignedAttachmentUrl.mockResolvedValue(null);
  open(UPLOAD);

  expect(await screen.findByText("Couldn't load this image.")).toBeInTheDocument();
  expect(screen.queryByRole('img')).toBeNull();
  expect(screen.getByText('sheet.png')).toBeInTheDocument();
});

it('draws a legacy /uploads/ image at once from the API origin, without minting', () => {
  open('/uploads/picture.png');
  expect(getSignedAttachmentUrl).not.toHaveBeenCalled();
  expect(screen.getByRole('img', { name: 'sheet.png' })).toHaveAttribute('src', new URL('/uploads/picture.png', getApiBaseUrl()).toString());
});
