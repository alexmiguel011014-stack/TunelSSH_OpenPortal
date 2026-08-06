import { useState, useCallback } from 'react';

export default function useVnc(_addLog) {
  const [status] = useState('disconnected');
  const [errorMessage] = useState(null);
  const [needPassword] = useState(false);

  const connect = useCallback(() => {}, []);
  const disconnect = useCallback(() => {}, []);

  return { status, errorMessage, needPassword, connect, disconnect };
}
