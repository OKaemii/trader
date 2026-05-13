import { AppNav } from '@/components/AppNav'

export default function AuthedLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-950">
      <AppNav />
      <main>{children}</main>
    </div>
  )
}
