'use client'
// Thin dark-themed wrapper over @radix-ui/react-dialog — an accessible modal
// (focus trap, Escape-to-close, labelled by title/description for screen readers).
//
// Available for rich confirm/detail modals in later cards. For simple
// confirm-before-mutate flows the portal still uses window.confirm (see AGENTS.md);
// reach for this when a modal needs custom layout (e.g. a form or a diff preview).
//
//   <Dialog>
//     <DialogTrigger>Open</DialogTrigger>
//     <DialogContent>
//       <DialogTitle>Confirm</DialogTitle>
//       <DialogDescription>Spell out the consequence here.</DialogDescription>
//       …actions…
//     </DialogContent>
//   </Dialog>
import * as RadixDialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { forwardRef } from 'react'
import { cn } from './cn'

export const Dialog = RadixDialog.Root
export const DialogTrigger = RadixDialog.Trigger
export const DialogClose = RadixDialog.Close
export const DialogPortal = RadixDialog.Portal

export const DialogOverlay = forwardRef<
  React.ComponentRef<typeof RadixDialog.Overlay>,
  React.ComponentPropsWithoutRef<typeof RadixDialog.Overlay>
>(function DialogOverlay({ className, ...props }, ref) {
  return (
    <RadixDialog.Overlay
      ref={ref}
      className={cn('fixed inset-0 z-50 bg-black/70 backdrop-blur-sm', className)}
      {...props}
    />
  )
})

export const DialogContent = forwardRef<
  React.ComponentRef<typeof RadixDialog.Content>,
  React.ComponentPropsWithoutRef<typeof RadixDialog.Content> & { showClose?: boolean }
>(function DialogContent({ className, children, showClose = true, ...props }, ref) {
  return (
    <RadixDialog.Portal>
      <DialogOverlay />
      <RadixDialog.Content
        ref={ref}
        className={cn(
          'fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2',
          'rounded-lg border border-gray-800 bg-gray-900 p-6 text-gray-200 shadow-xl',
          'focus:outline-none',
          className,
        )}
        {...props}
      >
        {children}
        {showClose && (
          <RadixDialog.Close
            aria-label="Close"
            className="absolute right-4 top-4 text-gray-500 transition-colors hover:text-gray-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500"
          >
            <X className="h-4 w-4" />
          </RadixDialog.Close>
        )}
      </RadixDialog.Content>
    </RadixDialog.Portal>
  )
})

export const DialogTitle = forwardRef<
  React.ComponentRef<typeof RadixDialog.Title>,
  React.ComponentPropsWithoutRef<typeof RadixDialog.Title>
>(function DialogTitle({ className, ...props }, ref) {
  return (
    <RadixDialog.Title
      ref={ref}
      className={cn('text-base font-semibold text-white', className)}
      {...props}
    />
  )
})

export const DialogDescription = forwardRef<
  React.ComponentRef<typeof RadixDialog.Description>,
  React.ComponentPropsWithoutRef<typeof RadixDialog.Description>
>(function DialogDescription({ className, ...props }, ref) {
  return (
    <RadixDialog.Description
      ref={ref}
      className={cn('mt-2 text-sm text-gray-400', className)}
      {...props}
    />
  )
})
