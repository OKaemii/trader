import { getUniverseOverrides } from '@/app/actions/admin'
import { UniverseEditor } from './UniverseEditor'

export default async function UniversePage() {
  const result = await getUniverseOverrides()

  if (!result.ok) {
    return (
      <div className="space-y-6 p-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Universe</h1>
        </div>
        <div className="rounded border border-red-900 bg-red-950 px-4 py-2 text-sm text-red-300">
          {result.status === 401 || result.status === 403
            ? 'Admin role required.'
            : `Failed to load (${result.status}).`}
        </div>
      </div>
    )
  }

  return <UniverseEditor initial={result.data} />
}
