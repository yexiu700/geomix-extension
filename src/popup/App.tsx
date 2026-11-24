import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExtensionPendingTaskDto, ExtensionProviderKey } from '../shared/bridge-contract';
import type { SerializedBridgeError } from '../shared/messages';
import type { PublicPairingState } from '../shared/storage';
import { AccountHeader } from './components/AccountHeader';
import { PairingView } from './components/PairingView';
import type { DispatchFeedbackState } from './components/TaskCard';
import { TaskQueueView } from './components/TaskQueueView';
import { callBackground } from './runtime';

type PairingNotice = {
  tone: 'info' | 'warn';
  message: string;
};

export function App() {
  const [bootstrapping, setBootstrapping] = useState(true);
  const [pairing, setPairing] = useState<PublicPairingState | null>(null);
  const [notice, setNotice] = useState<PairingNotice | null>(null);

  const [tasks, setTasks] = useState<ExtensionPendingTaskDto[]>([]);
  const [selectedBrandId, setSelectedBrandId] = useState('');
  const [selectedProvider, setSelectedProvider] = useState<ExtensionProviderKey | ''>('');
  const [loadingTasks, setLoadingTasks] = useState(false);
  const [tasksError, setTasksError] = useState<SerializedBridgeError | null>(null);
  const [unbinding, setUnbinding] = useState(false);
  const [dispatchFeedback, setDispatchFeedback] = useState<Record<string, DispatchFeedbackState>>(
    {},
  );

  const requestSeqRef = useRef(0);
  const sessionEpochRef = useRef(0);
  const pushingTasksRef = useRef<Set<string>>(new Set());
  const unbindingRef = useRef(false);

  const loadTasks = useCallback(
    async (brandId: string, provider: ExtensionProviderKey | ''): Promise<void> => {
      const seq = ++requestSeqRef.current;
      setLoadingTasks(true);
      setTasksError(null);

      const response = await callBackground({
        type: 'FETCH_PENDING_TASKS',
        payload: {
          ...(brandId ? { brandId } : {}),
          ...(provider ? { provider } : {}),
        },
      });

      if (seq !== requestSeqRef.current) {
        return;
      }

      if (!response.ok) {
        setTasks([]);
        setTasksError(response.error);
        setLoadingTasks(false);
        return;
      }

      setTasks(response.data.tasks);
      setTasksError(null);
      setLoadingTasks(false);
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;

    async function bootstrap(): Promise<void> {
      const statusResponse = await callBackground({ type: 'GET_PAIRING_STATUS' });
      if (cancelled) {
        return;
      }

      if (statusResponse.ok && statusResponse.data.paired) {
        const nextPairing: PublicPairingState = {
          baseUrl: statusResponse.data.baseUrl,
          me: statusResponse.data.me,
          pairedAt: statusResponse.data.pairedAt,
        };
        setPairing(nextPairing);
        setBootstrapping(false);
        void loadTasks('', '');
        return;
      }

      setPairing(null);
      setBootstrapping(false);
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [loadTasks]);

  const handlePaired = useCallback(
    (nextPairing: PublicPairingState) => {
      sessionEpochRef.current += 1;
      pushingTasksRef.current.clear();
      setNotice(null);
      setPairing(nextPairing);
      setSelectedBrandId('');
      setSelectedProvider('');
      setDispatchFeedback({});
      void loadTasks('', '');
    },
    [loadTasks],
  );

  const performUnbind = useCallback(
    async (
      nextNotice: PairingNotice,
      options?: { preservePendingTabTasks?: boolean },
    ): Promise<void> => {
      if (unbindingRef.current) {
        return;
      }
      unbindingRef.current = true;
      setUnbinding(true);
      try {
        sessionEpochRef.current += 1;
        requestSeqRef.current += 1;
        pushingTasksRef.current.clear();
        setLoadingTasks(false);
        const response = await callBackground(
          options?.preservePendingTabTasks
            ? { type: 'UNBIND_ACCOUNT', preservePendingTabTasks: true }
            : { type: 'UNBIND_ACCOUNT' },
        );
        if (!response.ok) {
          setTasksError(response.error);
          return;
        }
        setPairing(null);
        setTasks([]);
        setTasksError(null);
        setSelectedBrandId('');
        setSelectedProvider('');
        setDispatchFeedback({});
        setNotice(nextNotice);
      } finally {
        unbindingRef.current = false;
        setUnbinding(false);
      }
    },
    [],
  );

  const handleUnbind = useCallback(() => {
    void performUnbind({
      tone: 'info',
      message: '已解除绑定，本地配对 Token 已立即清除。',
    });
  }, [performUnbind]);

  const handleReauth = useCallback(() => {
    void performUnbind(
      {
        tone: 'warn',
        message: '配对 Token 已失效或已被吊销（401），本地凭证已清除，请重新配对。',
      },
      { preservePendingTabTasks: true },
    );
  }, [performUnbind]);

  const handleSelectBrand = useCallback(
    (brandId: string) => {
      setSelectedBrandId(brandId);
      void loadTasks(brandId, selectedProvider);
    },
    [loadTasks, selectedProvider],
  );

  const handleSelectProvider = useCallback(
    (provider: ExtensionProviderKey | '') => {
      setSelectedProvider(provider);
      void loadTasks(selectedBrandId, provider);
    },
    [loadTasks, selectedBrandId],
  );

  const handleRefresh = useCallback(() => {
    void loadTasks(selectedBrandId, selectedProvider);
  }, [loadTasks, selectedBrandId, selectedProvider]);

  const handlePushDraft = useCallback(async (task: ExtensionPendingTaskDto): Promise<void> => {
    if (unbindingRef.current || pushingTasksRef.current.has(task.taskId)) {
      return;
    }
    pushingTasksRef.current.add(task.taskId);
    const epoch = sessionEpochRef.current;
    setDispatchFeedback((prev) => ({
      ...prev,
      [task.taskId]: { status: 'dispatching' },
    }));

    try {
      const response = await callBackground({
        type: 'PUSH_DRAFT_TASK',
        payload: { task },
      });

      if (epoch !== sessionEpochRef.current) {
        return;
      }

      if (!response.ok) {
        if (
          response.error.reauthRequired ||
          response.error.kind === 'UNAUTHORIZED' ||
          response.error.httpStatus === 401
        ) {
          setTasksError(response.error);
        }
        setDispatchFeedback((prev) => ({
          ...prev,
          [task.taskId]: { status: 'error', error: response.error },
        }));
        return;
      }

      setDispatchFeedback((prev) => ({
        ...prev,
        [task.taskId]: { status: 'done', result: response.data },
      }));
    } finally {
      if (epoch === sessionEpochRef.current) {
        pushingTasksRef.current.delete(task.taskId);
      }
    }
  }, []);

  if (bootstrapping) {
    return (
      <main className="gm-app">
        <div role="status" aria-live="polite" className="gm-card gm-empty">
          <span>正在加载扩展状态...</span>
        </div>
      </main>
    );
  }

  if (!pairing) {
    return <PairingView notice={notice} onPaired={handlePaired} />;
  }

  return (
    <main className="gm-app">
      <AccountHeader pairing={pairing} unbinding={unbinding} onUnbind={handleUnbind} />
      <TaskQueueView
        brands={pairing.me.brands}
        tasks={tasks}
        selectedBrandId={selectedBrandId}
        selectedProvider={selectedProvider}
        loading={loadingTasks}
        unbinding={unbinding}
        error={tasksError}
        dispatchFeedback={dispatchFeedback}
        onSelectBrand={handleSelectBrand}
        onSelectProvider={handleSelectProvider}
        onRefresh={handleRefresh}
        onReauth={handleReauth}
        onPushDraft={(task) => {
          void handlePushDraft(task);
        }}
      />
    </main>
  );
}
