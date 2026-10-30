// client/src/components/PaymentForm.jsx
import { useState, useEffect, useRef } from 'react';
import { formatKenyanPhone, isValidKenyanPhone, formatPhoneForDisplay } from '../utils/phone';

const POLL_INTERVAL = 3000; // 3 seconds
const MAX_POLLS = 40; // 40 polls x 3 seconds = 2 minutes max

export default function PaymentForm({ amount: fixedAmount, description }) {
  const [phone, setPhone] = useState('');
  const [amount, setAmount] = useState(fixedAmount || '');
  const [step, setStep] = useState('form'); // form, processing, success, failed
  const [error, setError] = useState('');
  const [paymentData, setPaymentData] = useState(null);
  const [statusMessage, setStatusMessage] = useState('');
  const pollCountRef = useRef(0);
  const pollTimerRef = useRef(null);

  // Clean up polling on unmount
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
      }
    };
  }, []);

  // Validate phone number as user types
  const phoneError = phone.length > 0 && phone.length >= 10 && !isValidKenyanPhone(phone)
    ? 'Enter a valid Kenyan phone number (e.g., 0712 345 678)'
    : '';

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');

    // Validate phone
    const formattedPhone = formatKenyanPhone(phone);
    if (!formattedPhone) {
      setError('Please enter a valid Kenyan phone number.');
      return;
    }

    // Validate amount
    const parsedAmount = parseInt(amount, 10);
    if (!parsedAmount || parsedAmount < 1) {
      setError('Amount must be at least KES 1.');
      return;
    }

    // Send STK Push
    setStep('processing');
    setStatusMessage('Sending payment request to your phone...');

    try {
      const response = await fetch('/api/mpesa/stkpush', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phoneNumber: formattedPhone,
          amount: parsedAmount,
          accountReference: description || 'PayLink',
          transactionDesc: description || 'Payment',
        }),
      });

      const result = await response.json();

      if (!result.success) {
        setError(result.error || 'Failed to send payment request. Please try again.');
        setStep('form');
        return;
      }

      setPaymentData(result.data);
      setStatusMessage('Payment prompt sent. Please check your phone and enter your M-Pesa PIN.');

      // Start polling for payment status
      startPolling(result.data.paymentId);
    } catch {
      setError('Network error. Please check your connection and try again.');
      setStep('form');
    }
  }

  function startPolling(paymentId) {
    pollCountRef.current = 0;

    pollTimerRef.current = setInterval(async () => {
      pollCountRef.current += 1;

      if (pollCountRef.current > MAX_POLLS) {
        clearInterval(pollTimerRef.current);
        setStatusMessage('Payment request timed out. Please try again.');
        setStep('failed');
        return;
      }

      try {
        const response = await fetch(`/api/payments/${paymentId}/poll`);
        const result = await response.json();

        if (!result.success) return;

        const { status } = result.data;

        if (status === 'completed') {
          clearInterval(pollTimerRef.current);
          setPaymentData((prev) => ({ ...prev, ...result.data }));
          setStep('success');
        } else if (status === 'failed') {
          clearInterval(pollTimerRef.current);
          setStatusMessage(
            result.data.resultDesc || 'Payment failed. Please try again.'
          );
          setPaymentData((prev) => ({ ...prev, ...result.data }));
          setStep('failed');
        } else if (status === 'cancelled') {
          clearInterval(pollTimerRef.current);
          setStatusMessage(
            result.data.resultDesc ||
              'You cancelled the payment. If this was a mistake, click Pay again.'
          );
          setPaymentData((prev) => ({ ...prev, ...result.data }));
          setStep('failed');
        }
        // If still pending, continue polling
      } catch (err) {
        // Network error during poll -- continue polling, do not stop
        console.error('Poll error:', err);
      }
    }, POLL_INTERVAL);
  }

  function handleReset() {
    setStep('form');
    setError('');
    setPaymentData(null);
    setStatusMessage('');
    setPhone('');
    if (!fixedAmount) setAmount('');
    pollCountRef.current = 0;
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
    }
  }

  return (
    <div className="max-w-md mx-auto bg-white rounded-xl shadow-lg overflow-hidden">
      {/* Header */}
      <div className="bg-green-600 px-6 py-4">
        <h2 className="text-white text-xl font-bold">M-Pesa Payment</h2>
        {description && (
          <p className="text-green-100 text-sm mt-1">{description}</p>
        )}
      </div>

      <div className="p-6">
        {/* Step: Form */}
        {step === 'form' && (
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Amount Input */}
            <div>
              <label
                htmlFor="amount"
                className="block text-sm font-medium text-gray-700 mb-1"
              >
                Amount (KES)
              </label>
              {fixedAmount ? (
                <div className="text-3xl font-bold text-gray-900">
                  KES {parseInt(fixedAmount, 10).toLocaleString()}
                </div>
              ) : (
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 font-medium">
                    KES
                  </span>
                  <input
                    id="amount"
                    type="number"
                    min="1"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="0"
                    className="w-full pl-14 pr-4 py-3 border border-gray-300 rounded-lg text-lg focus:ring-2 focus:ring-green-500 focus:border-green-500 outline-none"
                    required
                  />
                </div>
              )}
            </div>

            {/* Phone Number Input */}
            <div>
              <label
                htmlFor="phone"
                className="block text-sm font-medium text-gray-700 mb-1"
              >
                M-Pesa Phone Number
              </label>
              <input
                id="phone"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="0712 345 678"
                className={`w-full px-4 py-3 border rounded-lg text-lg focus:ring-2 focus:ring-green-500 focus:border-green-500 outline-none ${
                  phoneError ? 'border-red-300' : 'border-gray-300'
                }`}
                required
              />
              {phoneError && (
                <p className="text-red-500 text-sm mt-1">{phoneError}</p>
              )}
              <p className="text-gray-400 text-xs mt-1">
                Safaricom number starting with 07 or 01
              </p>
            </div>

            {/* Error Message */}
            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm">
                {error}
              </div>
            )}

            {/* Submit Button */}
            <button
              type="submit"
              className="w-full bg-green-600 text-white py-3 rounded-lg font-semibold text-lg hover:bg-green-700 transition-colors"
            >
              Pay{amount ? ` KES ${parseInt(amount, 10).toLocaleString()}` : ''}
            </button>

            <p className="text-center text-gray-400 text-xs">
              You will receive an M-Pesa prompt on your phone to confirm the payment.
            </p>
          </form>
        )}

        {/* Step: Processing */}
        {step === 'processing' && (
          <div className="text-center py-8">
            {/* Spinner */}
            <div className="inline-block w-12 h-12 border-4 border-green-200 border-t-green-600 rounded-full animate-spin mb-4" />
            <h3 className="text-lg font-semibold text-gray-900 mb-2">
              Waiting for payment...
            </h3>
            <p className="text-gray-600 mb-4">{statusMessage}</p>
            <div className="bg-gray-50 rounded-lg p-4 text-left">
              <p className="text-sm text-gray-500">
                <span className="font-medium">Phone:</span>{' '}
                {formatPhoneForDisplay(formatKenyanPhone(phone))}
              </p>
              <p className="text-sm text-gray-500">
                <span className="font-medium">Amount:</span> KES{' '}
                {parseInt(amount, 10).toLocaleString()}
              </p>
            </div>
            <button
              onClick={handleReset}
              className="mt-6 text-gray-500 text-sm underline hover:text-gray-700"
            >
              Cancel and go back
            </button>
          </div>
        )}

        {/* Step: Success */}
        {step === 'success' && (
          <div className="text-center py-8">
            <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg
                className="w-8 h-8 text-green-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </div>
            <h3 className="text-xl font-bold text-gray-900 mb-2">
              Payment Successful
            </h3>
            <p className="text-gray-600 mb-6">
              Your payment of KES {parseInt(amount, 10).toLocaleString()} has been received.
            </p>

            {/* Receipt */}
            <div className="bg-gray-50 rounded-lg p-4 text-left space-y-2">
              {paymentData?.mpesaReceiptNumber && (
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">M-Pesa Receipt</span>
                  <span className="font-mono font-semibold text-gray-900">
                    {paymentData.mpesaReceiptNumber}
                  </span>
                </div>
              )}
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Amount</span>
                <span className="font-semibold text-gray-900">
                  KES {parseInt(amount, 10).toLocaleString()}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Phone</span>
                <span className="text-gray-900">
                  {formatPhoneForDisplay(formatKenyanPhone(phone))}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">Status</span>
                <span className="text-green-600 font-medium">Confirmed</span>
              </div>
            </div>

            <button
              onClick={handleReset}
              className="mt-6 w-full bg-gray-100 text-gray-700 py-3 rounded-lg font-medium hover:bg-gray-200 transition-colors"
            >
              Make Another Payment
            </button>
          </div>
        )}

        {/* Step: Failed */}
        {step === 'failed' && (
          <div className="text-center py-8">
            <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg
                className="w-8 h-8 text-red-600"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M6 18L18 6M6 6l12 12"
                />
              </svg>
            </div>
            <h3 className="text-xl font-bold text-gray-900 mb-2">
              Payment Failed
            </h3>
            <p className="text-gray-600 mb-6">{statusMessage}</p>

            <button
              onClick={handleReset}
              className="w-full bg-green-600 text-white py-3 rounded-lg font-semibold hover:bg-green-700 transition-colors"
            >
              Try Again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}