import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import CheckoutPage from '../CheckoutPage';

vi.mock('@/components/Header', () => ({ default: () => null }));
vi.mock('@/components/Footer', () => ({ default: () => null }));
vi.mock('@/components/ShoppingCart', () => ({ default: () => null }));
vi.mock('react-helmet', () => ({ Helmet: () => null }));
vi.mock('@/hooks/useCart', () => {
  const cart = {
    cartItems: [
      {
        quantity: 1,
        product: { id: '12', title: 'Kurta', sizes: ['M'] },
        variant: { id: 'v1', title: 'M', price_in_cents: 99900, sale_price_in_cents: null, currency_info: { code: 'INR' } },
      },
    ],
    clearCart: () => {},
    removeFromCart: () => {},
  };
  return { useCart: () => cart };
});

const ATTEMPT = '11111111-1111-4111-8111-111111111111';
const SUBMIT = /place order|pay now|pay /i;
let fetchMock;

// Mocked network only: no request ever leaves the test process.
beforeEach(() => {
  vi.stubGlobal('crypto', { randomUUID: () => ATTEMPT });
  fetchMock = vi.fn(async (url) => {
    if (url === '/api/payments/options') {
      return Response.json({ merchants: [1, 2, 3], sabpaisa: true, frontiva_payin: true });
    }
    return Response.json({ error: 'mocked failure' }, { status: 500 });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openOnline() {
  const user = userEvent.setup();
  render(
    <MemoryRouter>
      <CheckoutPage />
    </MemoryRouter>,
  );
  await user.click(screen.getByRole('radio', { name: /Pay Online/ }));
  await screen.findByRole('radio', { name: /Frontiva PayIn/ });
  return user;
}

const pickGateway = (user, name) => user.click(screen.getByRole('radio', { name }));
const emailField = () => screen.queryByLabelText(/Email Address/);
const calledWith = (part) => fetchMock.mock.calls.some(([u]) => String(u).includes(part));

async function fillDelivery(user) {
  await user.type(screen.getByLabelText(/Full Name/i), 'Asha Menon');
  await user.type(screen.getByLabelText(/Phone/i), '9876543210');
  await user.type(screen.getByLabelText(/Address/i), '12 MG Road');
}

describe('Frontiva PayIn email field', () => {
  test('Airpay 2 stays hidden even if the server still lists it', async () => {
    await openOnline();
    expect(screen.getByRole('radio', { name: /Airpay 1/ })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Airpay 3/ })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: /Airpay 2/ })).toBeNull();
  });

  test('appears directly below the gateway picker once PayIn is chosen, and not before', async () => {
    const user = await openOnline();
    expect(emailField()).toBeNull();

    await pickGateway(user, /Frontiva PayIn/);
    const field = emailField();
    expect(field).toBeTruthy();
    const picker = screen.getByRole('radiogroup', { name: /Select Payment Gateway/ }).parentElement;
    expect(picker.nextElementSibling.contains(field)).toBe(true);
  });

  test.each([[/Airpay 1/], [/Airpay 3/], [/SabPaisa/]])('is removed when switching to %s', async (name) => {
    const user = await openOnline();
    await pickGateway(user, /Frontiva PayIn/);
    expect(emailField()).toBeTruthy();
    await pickGateway(user, name);
    expect(emailField()).toBeNull();
  });

  test('keeps what was typed when switching away and back', async () => {
    const user = await openOnline();
    await pickGateway(user, /Frontiva PayIn/);
    await user.type(emailField(), 'asha@example.com');
    await pickGateway(user, /SabPaisa/);
    await pickGateway(user, /Frontiva PayIn/);
    expect(emailField().value).toBe('asha@example.com');
  });

  test('is required, and an invalid address is rejected before any request', async () => {
    const user = await openOnline();
    await fillDelivery(user);

    await pickGateway(user, /Frontiva PayIn/);
    await user.click(screen.getByRole('button', { name: SUBMIT }));
    expect(await screen.findByText('Email is required for Frontiva PayIn.')).toBeTruthy();

    await user.type(emailField(), 'not-an-email');
    await user.click(screen.getByRole('button', { name: SUBMIT }));
    expect(await screen.findByText('Enter a valid email address.')).toBeTruthy();
    expect(calledWith('frontiva-payin')).toBe(false);
  });

  test('a stale email error disappears when the gateway changes', async () => {
    const user = await openOnline();
    await fillDelivery(user);
    await pickGateway(user, /Frontiva PayIn/);
    await user.click(screen.getByRole('button', { name: SUBMIT }));
    await screen.findByText('Email is required for Frontiva PayIn.');

    await pickGateway(user, /Airpay 3/);
    expect(screen.queryByText('Email is required for Frontiva PayIn.')).toBeNull();
  });

  test('another gateway submits with no email and never calls the PayIn endpoint', async () => {
    const user = await openOnline();
    await fillDelivery(user);
    await pickGateway(user, /SabPaisa/);
    await user.click(screen.getByRole('button', { name: SUBMIT }));
    await waitFor(() => expect(calledWith('sabpaisa')).toBe(true));
    expect(screen.queryByText(/Email is required/)).toBeNull();
    expect(calledWith('frontiva-payin')).toBe(false);
  });

  test('sends the trimmed email, customer, items and attempt id to the PayIn endpoint', async () => {
    const user = await openOnline();
    await fillDelivery(user);
    await pickGateway(user, /Frontiva PayIn/);
    await user.type(emailField(), '  asha@example.com  ');
    await user.click(screen.getByRole('button', { name: SUBMIT }));

    await waitFor(() => expect(calledWith('/api/payments/frontiva-payin/create')).toBe(true));
    const [, init] = fetchMock.mock.calls.find(([u]) => u === '/api/payments/frontiva-payin/create');
    const body = JSON.parse(init.body);
    expect(body.email).toBe('asha@example.com');
    expect(body.attempt_id).toBe(ATTEMPT);
    expect(body.customer.fullName).toBe('Asha Menon');
    expect(body.items).toEqual([{ product_id: '12', size: 'M', quantity: 1 }]);
  });
});
