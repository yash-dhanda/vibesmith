import { execFile } from 'node:child_process'
import { statfsSync } from 'node:fs'
import { cpus, totalmem } from 'node:os'

export type SystemInfo = {
  ramGB: number
  cpu: string
  cores: number
  gpu: { name: string; vramGB: number; freeGB: number } | null // NVIDIA only for now; everything else counts as CPU
  diskFreeGB: number | null
}

// `nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader,nounits` prints "name, total MiB, free MiB" per GPU.
export function parseNvidiaSmi(out: string): SystemInfo['gpu'] {
  const gpus = out
    .split('\n')
    .map((l) => l.split(',').map((x) => x.trim()))
    .filter((p) => p.length >= 3 && p.slice(-2).every((n) => n !== '' && Number.isFinite(Number(n))))
    .map((p) => ({ name: p.slice(0, -2).join(', '), vramGB: Number(p.at(-2)) / 1024, freeGB: Number(p.at(-1)) / 1024 })) // a name may itself hold a comma
  return gpus.sort((a, b) => b.freeGB - a.freeGB)[0] ?? null // with several GPUs the one with the most free memory
}

// execFile only calls back once the process has exited, and a wedged GPU driver can leave nvidia-smi ignoring SIGTERM:
// kill hard and also stop waiting on our own clock, or the model list would never load.
const run = (cmd: string, args: string[]) =>
  new Promise<string>((resolve) => {
    const t = setTimeout(() => resolve(''), 6000)
    execFile(cmd, args, { timeout: 4000, killSignal: 'SIGKILL', windowsHide: true }, (err, out) => (clearTimeout(t), resolve(err ? '' : out)))
  })

export async function systemInfo(dir: string, run_ = run): Promise<SystemInfo> {
  let disk: number | null = null
  try {
    const s = statfsSync(dir)
    disk = (s.bavail * s.bsize) / 1024 ** 3
  } catch {}
  return {
    ramGB: totalmem() / 1024 ** 3,
    cpu: cpus()[0]?.model.trim() ?? 'CPU',
    cores: cpus().length,
    gpu: parseNvidiaSmi(await run_('nvidia-smi', ['--query-gpu=name,memory.total,memory.free', '--format=csv,noheader,nounits'])),
    diskFreeGB: disk,
  }
}

export type Fit = 'gpu' | 'partial' | 'cpu' | 'too-big'

// Will a model of this download size run well here? Calibrated on a real run: the 5.2 GB qwen3:8b used 5.6 GB in total
// (weights plus context) and sat fully on a GPU with 5.8 GB free.
export function fitFor(sizeGB: number, s: Pick<SystemInfo, 'ramGB' | 'gpu'>): Fit {
  const need = sizeGB * 1.04 + 0.3
  if (s.gpu && need <= s.gpu.freeGB) return 'gpu'
  if (s.gpu && sizeGB <= s.ramGB * 0.7 && need <= s.gpu.freeGB + s.ramGB * 0.5) return 'partial' // some layers on the GPU, the rest on the CPU
  if (need * 1.1 <= s.ramGB * 0.7) return 'cpu'
  return 'too-big'
}

// Ollama frees the model it keeps loaded when a different one is needed, so its video memory counts as free for ranking.
export function withLoadedVram<T extends Pick<SystemInfo, 'gpu'>>(s: T, loaded: { vramGB?: number }[]): T {
  if (!s.gpu) return s
  const back = loaded.reduce((n, m) => n + (m.vramGB ?? 0), 0)
  return { ...s, gpu: { ...s.gpu, freeGB: Math.min(s.gpu.vramGB, s.gpu.freeGB + back) } }
}

// Another computer's card is not ours, and its RAM is not known (only the card's memory is asked for): rate on the card alone.
export const remoteSystem = (vramGB: number): Pick<SystemInfo, 'ramGB' | 'gpu'> => ({ ramGB: 0, gpu: { name: 'Remote GPU', vramGB, freeGB: vramGB } })
