// client/src/App.jsx
import PaymentForm from './components/PaymentForm';

function App() {
  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
      <div className="w-full max-w-md">
        <h1 className="text-2xl font-bold text-center text-gray-900 mb-6">
          PayLink
        </h1>
        <PaymentForm
          description="Test Payment"
        />
      </div>
    </div>
  );
}

export default App;