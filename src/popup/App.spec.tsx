import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ExtensionMeDto, ExtensionPendingTaskDto } from '../shared/bridge-contract';
import type { ExtensionRuntimeRequest, MessageResponse } from '../shared/messages';
import type { PublicPairingState } from '../shared/storage';
import { App } from './App';

const DEMO_BASE_URL = 'https://geo.example.com';
const DEMO_TOKEN = 'gmext_demo_token_0001';

const DEMO_ME: ExtensionMeDto = {
  nickname: 'DemoOperator',
  tokenLabel: '测试设备',
  tokenPrefix: 'gmext_demo',
  expiresAt: '2026-12-31T23:59:59.000Z',
  brands: [
    {
      brandId: 'brand_demo_1',
      brandName: 'DemoBrand Alpha',
      brandMarketId: 'bm_cn_1',
      localBrandName: '示例品牌甲',
    },
    {
      brandId: 'brand_demo_2',
      brandName: 'DemoBrand Beta',
      brandMarketId: 'bm_cn_2',
      localBrandName: '示例品牌乙',
    },
  ],
};

const DEMO_PAIRING: PublicPairingState = {
  baseUrl: DEMO_BASE_URL,
  me: DEMO_ME,
  pairedAt: '2026-06-01T10:00:00.000Z',
};

const DEMO_TASKS: ExtensionPendingTaskDto[] = [
  {
    taskId: 'task_zhihu_1',
    articleId: 'art_1',
    brandId: 'brand_demo_1',
    brandName: '示例品牌甲',
    provider: 'ZHIHU_EXT',
    channelLabel: '知乎专栏',
    status: 'READY_TO_PUBLISH',
    variantTitle: '示例品牌甲 2026 实测对比指南',
    variantMarkdown: '# 指南',
    variantHtml: '<h1>指南</h1>',
    targetUrlHint: 'https://www.zhihu.com/question/123456',
    mediaAssets: [
      { url: 'https://cdn.example.com/assets/demo-1.png', alt: '测试图一', mime: 'image/png' },
      { url: 'https://cdn.example.com/assets/demo-2.png', alt: '测试图二', mime: 'image/png' },
    ],
    complianceChecklist: ['避免绝对化第一用语', '确认对比数据来源'],
    updatedAt: '2026-06-01T10:00:00.000Z',
  },
  {
    taskId: 'task_toutiao_2',
    articleId: 'art_2',
    brandId: 'brand_demo_2',
    brandName: '示例品牌乙',
    provider: 'TOUTIAO_EXT',
    channelLabel: '今日头条图文',
    status: 'DRAFT_VARIANT',
    variantTitle: '示例品牌乙选购避坑清单',
    variantMarkdown: '# 避坑',
    variantHtml: '<h1>避坑</h1>',
    targetUrlHint: null,
    mediaAssets: [{ url: 'https://cdn.example.com/assets/demo-3.jpg', alt: '封面图' }],
    complianceChecklist: ['头条号避免站外导流微信号'],
    updatedAt: '2026-06-01T11:00:00.000Z',
  },
  {
    taskId: 'task_smzdm_3',
    articleId: 'art_3',
    brandId: 'brand_demo_1',
    brandName: '示例品牌甲',
    provider: 'SMZDM_EXT',
    channelLabel: '什么值得买好文',
    status: 'READY_TO_PUBLISH',
    variantTitle: '示例品牌甲参数横评报告',
    variantMarkdown: '# 横评',
    variantHtml: '<h1>横评</h1>',
    targetUrlHint: null,
    mediaAssets: [],
    complianceChecklist: ['按平台规范披露体验来源'],
    updatedAt: '2026-06-01T12:00:00.000Z',
  },
];

function mockSendMessage(
  handler: (
    req: ExtensionRuntimeRequest,
  ) => MessageResponse<unknown> | Promise<MessageResponse<unknown>>,
) {
  (chrome.runtime.sendMessage as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (request: unknown) => handler(request as ExtensionRuntimeRequest),
  );
}

function mockPermissions(options: { contains?: boolean; request?: boolean }) {
  if (options.contains !== undefined) {
    (chrome.permissions.contains as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      options.contains,
    );
  }
  if (options.request !== undefined) {
    (chrome.permissions.request as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(
      options.request,
    );
  }
}

describe('Popup App', () => {
  it('renders unpaired PairingView with masked password token input', async () => {
    mockSendMessage((req) => {
      if (req.type === 'GET_PAIRING_STATUS') {
        return { ok: true, data: { paired: false } };
      }
      throw new Error(`Unexpected message: ${req.type}`);
    });

    render(<App />);

    const urlInput = await screen.findByLabelText('GeoMix 服务地址');
    const tokenInput = screen.getByLabelText('配对 Token（gmext_）');
    const submitBtn = screen.getByRole('button', { name: '验证并配对' });

    expect(urlInput.getAttribute('type')).toBe('url');
    expect(tokenInput.getAttribute('type')).toBe('password');
    expect(submitBtn).toBeTruthy();
  });

  it('rejects non-HTTPS or private base URLs before requesting permissions or calling SW', async () => {
    mockSendMessage(() => ({ ok: true, data: { paired: false } }));

    render(<App />);
    const urlInput = await screen.findByLabelText('GeoMix 服务地址');
    const tokenInput = screen.getByLabelText('配对 Token（gmext_）');

    fireEvent.change(urlInput, { target: { value: 'http://geo.example.com' } });
    fireEvent.change(tokenInput, { target: { value: DEMO_TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: '验证并配对' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('HTTPS');
    expect(chrome.permissions.request).not.toHaveBeenCalled();

    fireEvent.change(urlInput, { target: { value: 'https://127.0.0.1' } });
    fireEvent.click(screen.getByRole('button', { name: '验证并配对' }));

    const privateAlert = await screen.findByRole('alert');
    expect(privateAlert.textContent).toContain('HTTPS');
    expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid gmext_ token format before requesting permissions or calling SW', async () => {
    mockSendMessage(() => ({ ok: true, data: { paired: false } }));

    render(<App />);
    const urlInput = await screen.findByLabelText('GeoMix 服务地址');
    const tokenInput = screen.getByLabelText('配对 Token（gmext_）');

    fireEvent.change(urlInput, { target: { value: DEMO_BASE_URL } });
    fireEvent.change(tokenInput, { target: { value: 'invalid_token' } });
    fireEvent.click(screen.getByRole('button', { name: '验证并配对' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('gmext_');
    expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('shows clear guidance when dynamic optional_host_permissions request is denied', async () => {
    mockSendMessage(() => ({ ok: true, data: { paired: false } }));
    mockPermissions({ contains: false, request: false });

    render(<App />);
    const urlInput = await screen.findByLabelText('GeoMix 服务地址');
    const tokenInput = screen.getByLabelText('配对 Token（gmext_）');

    fireEvent.change(urlInput, { target: { value: DEMO_BASE_URL } });
    fireEvent.change(tokenInput, { target: { value: DEMO_TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: '验证并配对' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('未授予 https://geo.example.com 的 HTTPS 访问权限');
    expect(chrome.permissions.request).toHaveBeenCalledWith({
      origins: ['https://geo.example.com/*'],
    });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('completes pairing flow after host permission approval and transitions to paired task queue', async () => {
    mockPermissions({ contains: false, request: true });

    mockSendMessage((req) => {
      if (req.type === 'GET_PAIRING_STATUS') {
        return { ok: true, data: { paired: false } };
      }
      if (req.type === 'PAIR_ACCOUNT') {
        return { ok: true, data: DEMO_PAIRING };
      }
      if (req.type === 'FETCH_PENDING_TASKS') {
        return { ok: true, data: { tasks: DEMO_TASKS } };
      }
      throw new Error(`Unexpected message: ${req.type}`);
    });

    render(<App />);
    const urlInput = await screen.findByLabelText('GeoMix 服务地址');
    const tokenInput = screen.getByLabelText('配对 Token（gmext_）');

    fireEvent.change(urlInput, { target: { value: `${DEMO_BASE_URL}/` } });
    fireEvent.change(tokenInput, { target: { value: DEMO_TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: '验证并配对' }));

    expect(await screen.findByText('DemoOperator')).toBeTruthy();
    expect(screen.getByText(/测试设备 · gmext_demo/)).toBeTruthy();
    expect(screen.getByText('示例品牌甲 2026 实测对比指南')).toBeTruthy();
    expect(chrome.permissions.request).toHaveBeenCalledWith({
      origins: ['https://geo.example.com/*'],
    });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'PAIR_ACCOUNT',
      payload: { baseUrl: DEMO_BASE_URL, token: DEMO_TOKEN },
    });
  });

  it('shows 401 guidance on pairing failure without leaking token', async () => {
    mockSendMessage((req) => {
      if (req.type === 'GET_PAIRING_STATUS') {
        return { ok: true, data: { paired: false } };
      }
      if (req.type === 'PAIR_ACCOUNT') {
        return {
          ok: false,
          error: {
            kind: 'UNAUTHORIZED',
            httpStatus: 401,
            message: 'token expired',
            reauthRequired: true,
          },
        };
      }
      throw new Error(`Unexpected message: ${req.type}`);
    });

    render(<App />);
    const urlInput = await screen.findByLabelText('GeoMix 服务地址');
    const tokenInput = screen.getByLabelText('配对 Token（gmext_）');

    fireEvent.change(urlInput, { target: { value: DEMO_BASE_URL } });
    fireEvent.change(tokenInput, { target: { value: DEMO_TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: '验证并配对' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('401');
    expect(alert.textContent).not.toContain(DEMO_TOKEN);
  });

  it('renders task cards with complianceChecklist and draft-only CTAs (never containing 发布)', async () => {
    mockSendMessage((req) => {
      if (req.type === 'GET_PAIRING_STATUS') {
        return { ok: true, data: { paired: true, ...DEMO_PAIRING } };
      }
      if (req.type === 'FETCH_PENDING_TASKS') {
        return { ok: true, data: { tasks: DEMO_TASKS } };
      }
      throw new Error(`Unexpected message: ${req.type}`);
    });

    render(<App />);

    expect(await screen.findByText('示例品牌甲 2026 实测对比指南')).toBeTruthy();
    expect(screen.getByText('示例品牌乙选购避坑清单')).toBeTruthy();
    expect(screen.getByText('示例品牌甲参数横评报告')).toBeTruthy();
    expect(screen.getByText('配图 2 张')).toBeTruthy();

    const checklists = screen.getAllByTestId('compliance-checklist');
    expect(checklists).toHaveLength(3);
    expect(within(checklists[0]!).getByText('避免绝对化第一用语')).toBeTruthy();

    const buttons = screen.getAllByRole('button');
    for (const button of buttons) {
      expect(button.textContent).not.toContain('发布');
    }
    const pushButtons = screen.getAllByRole('button', { name: '写入草稿箱' });
    expect(pushButtons).toHaveLength(3);
  });

  it('filters queue by CN brand and platform and supports manual refresh', async () => {
    mockSendMessage((req) => {
      if (req.type === 'GET_PAIRING_STATUS') {
        return { ok: true, data: { paired: true, ...DEMO_PAIRING } };
      }
      if (req.type === 'FETCH_PENDING_TASKS') {
        const filtered = DEMO_TASKS.filter((task) => {
          if (req.payload?.brandId && task.brandId !== req.payload.brandId) return false;
          if (req.payload?.provider && task.provider !== req.payload.provider) return false;
          return true;
        });
        return { ok: true, data: { tasks: filtered } };
      }
      throw new Error(`Unexpected message: ${req.type}`);
    });

    render(<App />);
    await screen.findByText('示例品牌甲 2026 实测对比指南');

    const brandSelect = screen.getByLabelText('筛选品牌');
    fireEvent.change(brandSelect, { target: { value: 'brand_demo_1' } });

    await waitFor(() => {
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
        type: 'FETCH_PENDING_TASKS',
        payload: { brandId: 'brand_demo_1' },
      });
    });
    expect(screen.queryByText('示例品牌乙选购避坑清单')).toBeNull();

    const platformSelect = screen.getByLabelText('筛选平台');
    fireEvent.change(platformSelect, { target: { value: 'ZHIHU_EXT' } });

    await waitFor(() => {
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
        type: 'FETCH_PENDING_TASKS',
        payload: { brandId: 'brand_demo_1', provider: 'ZHIHU_EXT' },
      });
    });
    expect(screen.queryByText('示例品牌甲参数横评报告')).toBeNull();
    expect(screen.getByText('示例品牌甲 2026 实测对比指南')).toBeTruthy();

    const callCountBeforeRefresh = vi.mocked(chrome.runtime.sendMessage).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: '刷新队列' }));
    await waitFor(() => {
      expect(vi.mocked(chrome.runtime.sendMessage).mock.calls.length).toBe(
        callCountBeforeRefresh + 1,
      );
    });
  });

  it('dispatches PUSH_DRAFT_TASK and renders both M1 stub notice and PARTIAL_MEDIA_FAILED report', async () => {
    mockSendMessage((req) => {
      if (req.type === 'GET_PAIRING_STATUS') {
        return { ok: true, data: { paired: true, ...DEMO_PAIRING } };
      }
      if (req.type === 'FETCH_PENDING_TASKS') {
        return { ok: true, data: { tasks: DEMO_TASKS.slice(0, 2) } };
      }
      if (req.type === 'PUSH_DRAFT_TASK') {
        if (req.payload.task.taskId === 'task_zhihu_1') {
          return {
            ok: true,
            data: {
              taskId: 'task_zhihu_1',
              accepted: false,
              stage: 'NOT_IMPLEMENTED',
              stub: true,
              message: '草稿箱自动注入引擎将在 Batch 1 接入，当前已完成任务与配对校验。',
            },
          };
        }
        return {
          ok: true,
          data: {
            taskId: 'task_toutiao_2',
            accepted: true,
            stage: 'PARTIAL_MEDIA_FAILED',
            message: '正文已写入草稿箱，部分配图上传失败',
            report: {
              ok: false,
              stage: 'PARTIAL_MEDIA_FAILED',
              uploadedImages: 1,
              failedImages: 1,
              failedImageDetails: [
                {
                  url: 'https://cdn.example.com/assets/demo-fail.png',
                  alt: '封面图',
                  reason: '图片拉取超时',
                },
              ],
              message: '正文已写入草稿箱，部分配图上传失败',
            },
          },
        };
      }
      throw new Error(`Unexpected message: ${req.type}`);
    });

    render(<App />);
    const zhihuCard = await screen.findByTestId('task-card-task_zhihu_1');
    fireEvent.click(within(zhihuCard).getByRole('button', { name: '写入草稿箱' }));

    expect(
      await within(zhihuCard).findByText(
        '草稿箱自动注入引擎将在 Batch 1 接入，当前已完成任务与配对校验。',
      ),
    ).toBeTruthy();

    const toutiaoCard = screen.getByTestId('task-card-task_toutiao_2');
    fireEvent.click(within(toutiaoCard).getByRole('button', { name: '写入草稿箱' }));

    expect(await within(toutiaoCard).findByText(/成功 1 张，失败 1 张/)).toBeTruthy();
    expect(within(toutiaoCard).getByText('封面图：图片拉取超时')).toBeTruthy();
  });

  it('displays 401 re-pair banner on revoked token and unbinds on 重新配对 click', async () => {
    mockSendMessage((req) => {
      if (req.type === 'GET_PAIRING_STATUS') {
        return { ok: true, data: { paired: true, ...DEMO_PAIRING } };
      }
      if (req.type === 'FETCH_PENDING_TASKS') {
        return {
          ok: false,
          error: {
            kind: 'UNAUTHORIZED',
            httpStatus: 401,
            message: 'token revoked',
            reauthRequired: true,
          },
        };
      }
      if (req.type === 'UNBIND_ACCOUNT') {
        return { ok: true, data: { unbound: true } };
      }
      throw new Error(`Unexpected message: ${req.type}`);
    });

    render(<App />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('401');

    fireEvent.click(screen.getByRole('button', { name: '重新配对' }));

    expect(await screen.findByLabelText('GeoMix 服务地址')).toBeTruthy();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'UNBIND_ACCOUNT',
      preservePendingTabTasks: true,
    });
  });

  it('disables 重新配对 while unbinding in-flight and blocks synchronous double-click', async () => {
    let resolveUnbind: ((res: MessageResponse<unknown>) => void) | null = null;
    let unbindCalls = 0;

    mockSendMessage((req) => {
      if (req.type === 'GET_PAIRING_STATUS') {
        return { ok: true, data: { paired: true, ...DEMO_PAIRING } };
      }
      if (req.type === 'FETCH_PENDING_TASKS') {
        return {
          ok: false,
          error: {
            kind: 'UNAUTHORIZED',
            httpStatus: 401,
            message: 'token revoked',
            reauthRequired: true,
          },
        };
      }
      if (req.type === 'UNBIND_ACCOUNT') {
        unbindCalls += 1;
        return new Promise<MessageResponse<unknown>>((resolve) => {
          resolveUnbind = resolve;
        });
      }
      throw new Error(`Unexpected message: ${req.type}`);
    });

    render(<App />);
    await screen.findByRole('alert');

    const reauthButton = screen.getByRole('button', { name: '重新配对' }) as HTMLButtonElement;
    fireEvent.click(reauthButton);
    fireEvent.click(reauthButton);

    await waitFor(() => {
      expect(reauthButton.disabled).toBe(true);
    });
    expect(unbindCalls).toBe(1);
    expect(resolveUnbind).not.toBeNull();

    resolveUnbind!({ ok: true, data: { unbound: true } });
    expect(await screen.findByLabelText('GeoMix 服务地址')).toBeTruthy();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'UNBIND_ACCOUNT',
      preservePendingTabTasks: true,
    });
  });

  it('handles empty queue, network error retry, and one-click unbind', async () => {
    let fetchCount = 0;
    mockSendMessage((req) => {
      if (req.type === 'GET_PAIRING_STATUS') {
        return { ok: true, data: { paired: true, ...DEMO_PAIRING } };
      }
      if (req.type === 'FETCH_PENDING_TASKS') {
        fetchCount += 1;
        if (fetchCount === 1) {
          return {
            ok: false,
            error: {
              kind: 'NETWORK_ERROR',
              message: '无法连接 GeoMix 服务',
              reauthRequired: false,
            },
          };
        }
        return { ok: true, data: { tasks: [] } };
      }
      if (req.type === 'UNBIND_ACCOUNT') {
        return { ok: true, data: { unbound: true } };
      }
      throw new Error(`Unexpected message: ${req.type}`);
    });

    render(<App />);
    const errorAlert = await screen.findByRole('alert');
    expect(errorAlert.textContent).toContain('无法连接 GeoMix 服务');

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(await screen.findByText('当前筛选条件下暂无待发任务')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '解除绑定' }));
    expect(await screen.findByText('已解除绑定，本地配对 Token 已立即清除。')).toBeTruthy();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'UNBIND_ACCOUNT' });
  });

  it('ignores stale pre-unbind PUSH_DRAFT_TASK resolution after unbind and re-pair', async () => {
    let resolveStalePush: ((res: MessageResponse<unknown>) => void) | null = null;
    let paired = true;

    mockPermissions({ contains: true });
    mockSendMessage((req) => {
      if (req.type === 'GET_PAIRING_STATUS') {
        return { ok: true, data: { paired: true, ...DEMO_PAIRING } };
      }
      if (req.type === 'FETCH_PENDING_TASKS') {
        return { ok: true, data: { tasks: [DEMO_TASKS[0]!] } };
      }
      if (req.type === 'PUSH_DRAFT_TASK') {
        return new Promise<MessageResponse<unknown>>((resolve) => {
          resolveStalePush = resolve;
        });
      }
      if (req.type === 'UNBIND_ACCOUNT') {
        paired = false;
        return { ok: true, data: { unbound: true } };
      }
      if (req.type === 'PAIR_ACCOUNT') {
        paired = true;
        return { ok: true, data: DEMO_PAIRING };
      }
      throw new Error(`Unexpected message: ${JSON.stringify(req)}`);
    });

    render(<App />);
    const card = await screen.findByTestId('task-card-task_zhihu_1');
    fireEvent.click(within(card).getByRole('button', { name: '写入草稿箱' }));
    expect(resolveStalePush).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '解除绑定' }));
    const urlInput = await screen.findByLabelText('GeoMix 服务地址');
    expect(paired).toBe(false);

    const tokenInput = screen.getByLabelText('配对 Token（gmext_）');
    fireEvent.change(urlInput, { target: { value: DEMO_BASE_URL } });
    fireEvent.change(tokenInput, { target: { value: DEMO_TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: '验证并配对' }));

    await screen.findByText('示例品牌甲 2026 实测对比指南');
    expect(paired).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();

    resolveStalePush!({
      ok: false,
      error: {
        kind: 'NOT_PAIRED',
        message: '尚未配对 GeoMix 账号，请先完成配对。',
        reauthRequired: true,
      },
    });

    await waitFor(() => {
      expect(screen.queryByRole('alert')).toBeNull();
    });
    expect(screen.queryByText('尚未配对 GeoMix 账号，请先完成配对。')).toBeNull();
    expect(screen.queryByRole('button', { name: '重新配对' })).toBeNull();
  });

  it('surfaces error banner and keeps session when UNBIND_ACCOUNT fails', async () => {
    mockSendMessage((req) => {
      if (req.type === 'GET_PAIRING_STATUS') {
        return { ok: true, data: { paired: true, ...DEMO_PAIRING } };
      }
      if (req.type === 'FETCH_PENDING_TASKS') {
        return { ok: true, data: { tasks: [DEMO_TASKS[0]!] } };
      }
      if (req.type === 'UNBIND_ACCOUNT') {
        return {
          ok: false,
          error: {
            kind: 'NETWORK_ERROR',
            message: '存储清理失败，请稍后重试。',
            reauthRequired: false,
          },
        };
      }
      throw new Error(`Unexpected message: ${req.type}`);
    });

    render(<App />);
    await screen.findByText('示例品牌甲 2026 实测对比指南');

    fireEvent.click(screen.getByRole('button', { name: '解除绑定' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('存储清理失败，请稍后重试。');
    expect(screen.queryByText('已解除绑定，本地配对 Token 已立即清除。')).toBeNull();
  });

  it('keeps filter selects interactive during in-flight fetch and discards stale responses', async () => {
    let resolveFirstFetch: ((res: MessageResponse<unknown>) => void) | null = null;
    let fetchCalls = 0;

    mockSendMessage((req) => {
      if (req.type === 'GET_PAIRING_STATUS') {
        return { ok: true, data: { paired: true, ...DEMO_PAIRING } };
      }
      if (req.type === 'FETCH_PENDING_TASKS') {
        fetchCalls += 1;
        if (fetchCalls === 1) {
          return new Promise<MessageResponse<unknown>>((resolve) => {
            resolveFirstFetch = resolve;
          });
        }
        return { ok: true, data: { tasks: [DEMO_TASKS[1]!] } };
      }
      throw new Error(`Unexpected message: ${req.type}`);
    });

    render(<App />);
    const brandSelect = (await screen.findByLabelText('筛选品牌')) as HTMLSelectElement;
    const platformSelect = screen.getByLabelText('筛选平台') as HTMLSelectElement;

    expect(brandSelect.disabled).toBe(false);
    expect(platformSelect.disabled).toBe(false);

    fireEvent.change(brandSelect, { target: { value: 'brand_demo_2' } });
    expect(await screen.findByText('示例品牌乙选购避坑清单')).toBeTruthy();

    resolveFirstFetch!({ ok: true, data: { tasks: [DEMO_TASKS[0]!] } });
    await waitFor(() => {
      expect(screen.getByText('示例品牌乙选购避坑清单')).toBeTruthy();
    });
    expect(screen.queryByText('示例品牌甲 2026 实测对比指南')).toBeNull();
  });

  it('requests port-free MV3 originPattern while preserving custom port for PAIR_ACCOUNT', async () => {
    mockPermissions({ contains: false, request: true });

    mockSendMessage((req) => {
      if (req.type === 'GET_PAIRING_STATUS') {
        return { ok: true, data: { paired: false } };
      }
      if (req.type === 'PAIR_ACCOUNT') {
        return {
          ok: true,
          data: {
            ...DEMO_PAIRING,
            baseUrl: 'https://geo.example.com:8443/api-proxy',
          },
        };
      }
      if (req.type === 'FETCH_PENDING_TASKS') {
        return { ok: true, data: { tasks: [] } };
      }
      throw new Error(`Unexpected message: ${req.type}`);
    });

    render(<App />);
    const urlInput = await screen.findByLabelText('GeoMix 服务地址');
    const tokenInput = screen.getByLabelText('配对 Token（gmext_）');

    fireEvent.change(urlInput, { target: { value: 'https://geo.example.com:8443/api-proxy/' } });
    fireEvent.change(tokenInput, { target: { value: DEMO_TOKEN } });
    fireEvent.click(screen.getByRole('button', { name: '验证并配对' }));

    expect(await screen.findByText('DemoOperator')).toBeTruthy();
    expect(chrome.permissions.contains).toHaveBeenCalledWith({
      origins: ['https://geo.example.com/*'],
    });
    expect(chrome.permissions.request).toHaveBeenCalledWith({
      origins: ['https://geo.example.com/*'],
    });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      type: 'PAIR_ACCOUNT',
      payload: {
        baseUrl: 'https://geo.example.com:8443/api-proxy',
        token: DEMO_TOKEN,
      },
    });
  });

  it('blocks synchronous same-tick double-submit in PairingView via submittingRef guard', async () => {
    let resolvePair: ((res: MessageResponse<unknown>) => void) | null = null;
    let pairCalls = 0;

    mockPermissions({ contains: true });
    mockSendMessage((req) => {
      if (req.type === 'GET_PAIRING_STATUS') {
        return { ok: true, data: { paired: false } };
      }
      if (req.type === 'PAIR_ACCOUNT') {
        pairCalls += 1;
        return new Promise<MessageResponse<unknown>>((resolve) => {
          resolvePair = resolve;
        });
      }
      if (req.type === 'FETCH_PENDING_TASKS') {
        return { ok: true, data: { tasks: [] } };
      }
      throw new Error(`Unexpected message: ${req.type}`);
    });

    render(<App />);
    const urlInput = await screen.findByLabelText('GeoMix 服务地址');
    const tokenInput = screen.getByLabelText('配对 Token（gmext_）');
    fireEvent.change(urlInput, { target: { value: DEMO_BASE_URL } });
    fireEvent.change(tokenInput, { target: { value: DEMO_TOKEN } });

    const form = urlInput.closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);

    await waitFor(() => {
      expect(pairCalls).toBe(1);
    });
    expect(resolvePair).not.toBeNull();
    resolvePair!({ ok: true, data: DEMO_PAIRING });
    expect(await screen.findByText('DemoOperator')).toBeTruthy();
  });

  it('renders live M2 INJECTED, PARTIAL_MEDIA_FAILED with operatorReminders, AUTH_REQUIRED, and EDITOR_NOT_FOUND feedback states', async () => {
    mockSendMessage((req) => {
      if (req.type === 'GET_PAIRING_STATUS') {
        return { ok: true, data: { paired: true, ...DEMO_PAIRING } };
      }
      if (req.type === 'FETCH_PENDING_TASKS') {
        return { ok: true, data: { tasks: DEMO_TASKS } };
      }
      if (req.type === 'PUSH_DRAFT_TASK') {
        if (req.payload.task.taskId === 'task_zhihu_1') {
          return {
            ok: true,
            data: {
              taskId: 'task_zhihu_1',
              accepted: true,
              stage: 'INJECTED',
              tabId: 101,
              message: '已写入知乎草稿箱',
              report: {
                ok: true,
                stage: 'INJECTED',
                uploadedImages: 2,
                failedImages: 0,
                operatorReminders: ['请核对专栏标签与封面图'],
                message: '已写入知乎草稿箱',
              },
            },
          };
        }
        if (req.payload.task.taskId === 'task_toutiao_2') {
          return {
            ok: true,
            data: {
              taskId: 'task_toutiao_2',
              accepted: false,
              stage: 'AUTH_REQUIRED',
              tabId: 102,
              message: '检测到头条号未登录，请先登录后重试。',
              report: {
                ok: false,
                stage: 'AUTH_REQUIRED',
                uploadedImages: 0,
                failedImages: 0,
                message: '检测到头条号未登录，请先登录后重试。',
              },
            },
          };
        }
        return {
          ok: true,
          data: {
            taskId: 'task_smzdm_3',
            accepted: true,
            stage: 'PARTIAL_MEDIA_FAILED',
            tabId: 103,
            message: '正文已写入什么值得买草稿箱，部分配图失败',
            report: {
              ok: false,
              stage: 'PARTIAL_MEDIA_FAILED',
              uploadedImages: 1,
              failedImages: 1,
              failedImageDetails: [
                {
                  url: 'https://cdn.example.com/smzdm-fail.png',
                  alt: '参数对比图',
                  reason: '下载超时',
                },
              ],
              operatorReminders: ['请手动插入值得买商品卡片'],
              message: '正文已写入什么值得买草稿箱，部分配图失败',
            },
          },
        };
      }
      throw new Error(`Unexpected message: ${req.type}`);
    });

    render(<App />);
    const zhihuCard = await screen.findByTestId('task-card-task_zhihu_1');
    fireEvent.click(within(zhihuCard).getByRole('button', { name: '写入草稿箱' }));
    expect(await within(zhihuCard).findByText(/已转存 2 张配图/)).toBeTruthy();
    expect(within(zhihuCard).getByText('请核对专栏标签与封面图')).toBeTruthy();

    const toutiaoCard = screen.getByTestId('task-card-task_toutiao_2');
    fireEvent.click(within(toutiaoCard).getByRole('button', { name: '写入草稿箱' }));
    expect(
      await within(toutiaoCard).findByText('检测到头条号未登录，请先登录后重试。'),
    ).toBeTruthy();

    const smzdmCard = screen.getByTestId('task-card-task_smzdm_3');
    fireEvent.click(within(smzdmCard).getByRole('button', { name: '写入草稿箱' }));
    expect(await within(smzdmCard).findByText('参数对比图：下载超时')).toBeTruthy();
    expect(within(smzdmCard).getByText('请手动插入值得买商品卡片')).toBeTruthy();
  });

  it('strips query parameters and redacts tokens in TaskCard failedImageDetails when alt is empty', async () => {
    mockSendMessage((req) => {
      if (req.type === 'GET_PAIRING_STATUS') {
        return { ok: true, data: { paired: true, ...DEMO_PAIRING } };
      }
      if (req.type === 'FETCH_PENDING_TASKS') {
        return { ok: true, data: { tasks: [DEMO_TASKS[0]!] } };
      }
      if (req.type === 'PUSH_DRAFT_TASK') {
        return {
          ok: true,
          data: {
            taskId: 'task_zhihu_1',
            accepted: true,
            stage: 'PARTIAL_MEDIA_FAILED',
            message: '部分配图失败',
            report: {
              ok: false,
              stage: 'PARTIAL_MEDIA_FAILED',
              uploadedImages: 0,
              failedImages: 2,
              failedImageDetails: [
                {
                  url: 'https://cdn.example.com/assets/pic.png?sig=xyz#top',
                  alt: '',
                  reason: '下载超时',
                },
                {
                  url: 'https://cdn.example.com/gmext_demo_token_1234/img.png?token=abc#frag',
                  alt: '',
                  reason: '网络错误 Bearer gmext_demo_token_5678',
                },
              ],
              message: '部分配图失败',
            },
          },
        };
      }
      throw new Error(`Unexpected message: ${req.type}`);
    });

    render(<App />);
    const card = await screen.findByTestId('task-card-task_zhihu_1');
    fireEvent.click(within(card).getByRole('button', { name: '写入草稿箱' }));

    const feedback = await within(card).findByRole('alert');
    expect(feedback.textContent).toContain('cdn.example.com/assets/pic.png：下载超时');
    expect(feedback.textContent).toContain('cdn.example.com/gmext_[REDACTED]');
    expect(feedback.textContent).not.toContain('sig=xyz');
    expect(feedback.textContent).not.toContain('token=abc');
    expect(feedback.textContent).not.toContain('gmext_demo_token_1234');
    expect(feedback.textContent).not.toContain('gmext_demo_token_5678');
  });

  it('ignores 写入草稿箱 clicks while UNBIND_ACCOUNT is in-flight (G7)', async () => {
    let resolveUnbind!: (value: { ok: true; data: { unbound: true } }) => void;
    let pushCalls = 0;

    mockSendMessage((req) => {
      if (req.type === 'GET_PAIRING_STATUS') {
        return { ok: true, data: { paired: true, ...DEMO_PAIRING } };
      }
      if (req.type === 'FETCH_PENDING_TASKS') {
        return { ok: true, data: { tasks: [DEMO_TASKS[0]!] } };
      }
      if (req.type === 'UNBIND_ACCOUNT') {
        return new Promise((resolve) => {
          resolveUnbind = resolve;
        });
      }
      if (req.type === 'PUSH_DRAFT_TASK') {
        pushCalls += 1;
        return {
          ok: true,
          data: {
            taskId: 'task_zhihu_1',
            accepted: true,
            stage: 'INJECTED',
            message: 'ok',
          },
        };
      }
      throw new Error(`Unexpected message: ${req.type}`);
    });

    render(<App />);
    const card = await screen.findByTestId('task-card-task_zhihu_1');

    fireEvent.click(screen.getByRole('button', { name: '解除绑定' }));
    fireEvent.click(within(card).getByRole('button', { name: '写入草稿箱' }));

    expect(pushCalls).toBe(0);

    resolveUnbind({ ok: true, data: { unbound: true } });
    await screen.findByText('已解除绑定，本地配对 Token 已立即清除。');
    expect(pushCalls).toBe(0);
  });
});
