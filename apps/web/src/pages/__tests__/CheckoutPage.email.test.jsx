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
  await screen.findAllByRole('radio', { name: /Frontiva PayIn/ });
  return user;
}

const pickGateway = (user, name) => user.click(screen.getByRole('radio', { name }));
const emailField = () => screen.queryByLabelText(/Email Address/);
const calledWith = (part) => fetchMock.mock.calls.some(([u]) => String(u).includes(part));

async function fillDelivery(user) {
  await user.type(screen.getByLabelText(/Full Name/i), 'Asha Menon');
  await user.type(screen.getByLabelText(/Phone/i), '9876543210');
  await user.type(screen.getByLabelText(/Full Address/i), '12 MG Road');
}

describe('Frontiva PayIn email field', () => {
  test('every Airpay option stays hidden even if the server still lists the merchants', async () => {
    await openOnline();
    for (const n of [1, 2, 3]) expect(screen.queryByRole('radio', { name: new RegExp(`Airpay ${n}`) })).toBeNull();
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

  test.each([[/SabPaisa/]])('is removed when switching to %s', async (name) => {
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

    await pickGateway(user, /SabPaisa/);
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

describe('Frontiva PayIn 2 (second PayIn account)', () => {
  const PAYIN_1 = 'Pay with Frontiva PayIn';
  const PAYIN_2 = 'Pay with Frontiva PayIn 2';

  const offer = (options) =>
    fetchMock.mockImplementation(async (url) =>
      url === '/api/payments/options' ? Response.json(options) : Response.json({ error: 'mocked failure' }, { status: 500 }),
    );

  const sentTo = (path) => JSON.parse(fetchMock.mock.calls.find(([u]) => u === path)[1].body);

  test('is not shown unless the server lists PayIn slot 2', async () => {
    await openOnline();
    expect(screen.getByRole('radio', { name: PAYIN_1 })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: PAYIN_2 })).toBeNull();
  });

  test('a server listing Airpay merchant 2 does not turn on PayIn 2 (separate namespaces)', async () => {
    offer({ merchants: [1, 2, 3], sabpaisa: true, frontiva_payin: true });
    await openOnline();
    expect(screen.queryByRole('radio', { name: PAYIN_2 })).toBeNull();
  });

  test('shown when listed; uses the same email field and sends merchant: 2', async () => {
    offer({ merchants: [3], sabpaisa: false, frontiva_payin: true, frontiva_payin_merchants: [1, 2] });
    const user = await openOnline();
    await fillDelivery(user);

    await pickGateway(user, PAYIN_2);
    expect(emailField()).toBeTruthy();
    await user.click(screen.getByRole('button', { name: SUBMIT }));
    expect(await screen.findByText('Email is required for Frontiva PayIn.')).toBeTruthy();
    expect(calledWith('frontiva-payin')).toBe(false);

    await user.type(emailField(), 'asha@example.com');
    await user.click(screen.getByRole('button', { name: SUBMIT }));
    await waitFor(() => expect(calledWith('/api/payments/frontiva-payin/create')).toBe(true));
    expect(sentTo('/api/payments/frontiva-payin/create').merchant).toBe(2);
    expect(calledWith('/api/payments/create')).toBe(false);
  });

  test('slot 2 can be offered while slot 1 is off', async () => {
    offer({ merchants: [], sabpaisa: true, frontiva_payin_merchants: [2] });
    await openOnline();
    expect(await screen.findByRole('radio', { name: PAYIN_2 })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: PAYIN_1 })).toBeNull();
  });

  test('slot 1 still sends exactly its original body, with no merchant key', async () => {
    offer({ merchants: [3], sabpaisa: false, frontiva_payin: true, frontiva_payin_merchants: [1, 2] });
    const user = await openOnline();
    await fillDelivery(user);
    await pickGateway(user, PAYIN_1);
    await user.type(emailField(), 'asha@example.com');
    await user.click(screen.getByRole('button', { name: SUBMIT }));

    await waitFor(() => expect(calledWith('/api/payments/frontiva-payin/create')).toBe(true));
    expect(Object.keys(sentTo('/api/payments/frontiva-payin/create')).sort()).toEqual(['attempt_id', 'customer', 'email', 'items']);
  });

  test('the email field stays when switching between the two PayIn accounts', async () => {
    offer({ merchants: [3], sabpaisa: false, frontiva_payin: true, frontiva_payin_merchants: [1, 2] });
    const user = await openOnline();
    await pickGateway(user, PAYIN_1);
    await user.type(emailField(), 'asha@example.com');
    await pickGateway(user, PAYIN_2);
    expect(emailField().value).toBe('asha@example.com');
  });
});


describe('Frontiva PayIn 3 (the third option, replacing Airpay 3)', () => {
  const PAYIN_3 = 'Pay with Frontiva PayIn 3';

  const offer = (options) =>
    fetchMock.mockImplementation(async (url) =>
      url === '/api/payments/options' ? Response.json(options) : Response.json({ error: 'mocked failure' }, { status: 500 }),
    );

  const sentTo = (path) => JSON.parse(fetchMock.mock.calls.find(([u]) => u === path)[1].body);

  test('is not shown unless the server lists PayIn slot 3; Airpay merchant 3 does not turn it on', async () => {
    offer({ merchants: [1, 2, 3], sabpaisa: true, frontiva_payin: true, frontiva_payin_merchants: [1, 2] });
    await openOnline();
    expect(screen.queryByRole('radio', { name: PAYIN_3 })).toBeNull();
  });

  test('takes the third checkout position: first in the list, where Airpay 3 used to be', async () => {
    offer({ merchants: [], sabpaisa: true, frontiva_payin: true, frontiva_payin_merchants: [1, 2, 3] });
    await openOnline();
    await screen.findByRole('radio', { name: PAYIN_3 });
    const names = screen.getAllByRole('radio').map((radio) => radio.getAttribute('aria-label') ?? radio.textContent);
    const at = (label) => names.findIndex((name) => name.includes(label));
    expect(at(PAYIN_3)).toBeGreaterThan(-1);
    expect(at(PAYIN_3)).toBeLessThan(at('Pay with SabPaisa'));
    expect(names.some((name) => /Airpay/.test(name))).toBe(false);
  });

  test('shown when listed; uses the same email field and sends merchant: 3 to the PayIn endpoint only', async () => {
    offer({ merchants: [], sabpaisa: false, frontiva_payin: true, frontiva_payin_merchants: [1, 3] });
    const user = await openOnline();
    await fillDelivery(user);

    await pickGateway(user, PAYIN_3);
    expect(emailField()).toBeTruthy();
    await user.click(screen.getByRole('button', { name: SUBMIT }));
    expect(await screen.findByText('Email is required for Frontiva PayIn.')).toBeTruthy();
    expect(calledWith('frontiva-payin')).toBe(false);

    await user.type(emailField(), 'asha@example.com');
    await user.click(screen.getByRole('button', { name: SUBMIT }));
    await waitFor(() => expect(calledWith('/api/payments/frontiva-payin/create')).toBe(true));
    const body = sentTo('/api/payments/frontiva-payin/create');
    expect(body.merchant).toBe(3);
    expect(body.email).toBe('asha@example.com');
    expect(body.attempt_id).toBe(ATTEMPT);
    expect(calledWith('/api/payments/create')).toBe(false);
  });

  test('as the only option it is selected by default and still collects the email', async () => {
    offer({ merchants: [], sabpaisa: false, frontiva_payin_merchants: [3] });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <CheckoutPage />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('radio', { name: /Pay Online/ }));
    await waitFor(() => expect(emailField()).toBeTruthy());
    await fillDelivery(user);
    await user.type(emailField(), 'asha@example.com');
    await user.click(screen.getByRole('button', { name: SUBMIT }));
    await waitFor(() => expect(calledWith('/api/payments/frontiva-payin/create')).toBe(true));
    expect(sentTo('/api/payments/frontiva-payin/create').merchant).toBe(3);
  });

  test('slot 1 and slot 2 bodies are unchanged by slot 3 being on', async () => {
    offer({ merchants: [], sabpaisa: false, frontiva_payin: true, frontiva_payin_merchants: [1, 2, 3] });
    const user = await openOnline();
    await fillDelivery(user);
    await pickGateway(user, 'Pay with Frontiva PayIn');
    await user.type(emailField(), 'asha@example.com');
    await user.click(screen.getByRole('button', { name: SUBMIT }));
    await waitFor(() => expect(calledWith('/api/payments/frontiva-payin/create')).toBe(true));
    expect(Object.keys(sentTo('/api/payments/frontiva-payin/create')).sort()).toEqual(['attempt_id', 'customer', 'email', 'items']);
  });

  test('when the options cannot be read, no online gateway (and never Airpay 3) is assumed', async () => {
    fetchMock.mockImplementation(async () => {
      throw new Error('network down');
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <CheckoutPage />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole('radio', { name: /Pay Online/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByRole('radio', { name: /Airpay|Frontiva/ })).toBeNull();
    expect(calledWith('/api/payments/create')).toBe(false);
  });
});
