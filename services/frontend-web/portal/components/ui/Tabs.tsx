'use client'
// Thin dark-themed wrapper over @radix-ui/react-tabs — an accessible, client-side
// tablist primitive (roving focus, aria-selected, arrow-key nav).
//
// NOTE on the workspace IA: the top-level workspace tabs are URL-addressable (`?tab=`)
// and SSR-rendered, so they are built as <Link> navigation in WorkspaceTabs (Task 2),
// NOT with this component. Use these Tabs for *in-page*, non-routed tab groups (e.g.
// sub-views inside one workspace tab) where the active tab need not survive a reload.
//
//   <Tabs defaultValue="a">
//     <TabsList><TabsTrigger value="a">A</TabsTrigger><TabsTrigger value="b">B</TabsTrigger></TabsList>
//     <TabsContent value="a">…</TabsContent><TabsContent value="b">…</TabsContent>
//   </Tabs>
import * as RadixTabs from '@radix-ui/react-tabs'
import { forwardRef } from 'react'
import { cn } from './cn'

export const Tabs = RadixTabs.Root

export const TabsList = forwardRef<
  React.ComponentRef<typeof RadixTabs.List>,
  React.ComponentPropsWithoutRef<typeof RadixTabs.List>
>(function TabsList({ className, ...props }, ref) {
  return (
    <RadixTabs.List
      ref={ref}
      className={cn('flex gap-1 border-b border-gray-800', className)}
      {...props}
    />
  )
})

export const TabsTrigger = forwardRef<
  React.ComponentRef<typeof RadixTabs.Trigger>,
  React.ComponentPropsWithoutRef<typeof RadixTabs.Trigger>
>(function TabsTrigger({ className, ...props }, ref) {
  return (
    <RadixTabs.Trigger
      ref={ref}
      className={cn(
        'rounded-t px-3 py-2 text-sm text-gray-400 transition-colors hover:text-gray-100',
        'data-[state=active]:border-b-2 data-[state=active]:border-emerald-500 data-[state=active]:text-white',
        'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500',
        className,
      )}
      {...props}
    />
  )
})

export const TabsContent = forwardRef<
  React.ComponentRef<typeof RadixTabs.Content>,
  React.ComponentPropsWithoutRef<typeof RadixTabs.Content>
>(function TabsContent({ className, ...props }, ref) {
  return (
    <RadixTabs.Content
      ref={ref}
      className={cn('mt-4 focus-visible:outline-none', className)}
      {...props}
    />
  )
})
