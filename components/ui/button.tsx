import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

// Board 1d: Deep Forest primary, Ink-outlined secondary, 4px radius, 44px minimum touch
// target, and a 2px Forest focus outline offset by 2px rather than a soft ring.
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center gap-2 rounded-md border border-transparent bg-clip-padding font-sans text-sm font-medium whitespace-nowrap transition-colors duration-150 ease-quiet outline-none select-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-forest disabled:pointer-events-none disabled:opacity-40 aria-invalid:border-error [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-forest text-ivory hover:bg-forest-hover",
        outline: "border-ink bg-transparent text-ink hover:bg-surface aria-expanded:bg-surface",
        secondary: "bg-surface text-ink hover:bg-sand/60 aria-expanded:bg-sand/60",
        ghost: "text-ink hover:bg-surface aria-expanded:bg-surface",
        destructive: "border-error bg-transparent text-error hover:bg-error/10 focus-visible:outline-error",
        link: "text-forest underline decoration-sand underline-offset-4 hover:text-ink hover:decoration-ink",
      },
      size: {
        default: "min-h-11 px-5 py-2.5",
        xs: "min-h-7 gap-1 px-2 text-xs [&_svg:not([class*='size-'])]:size-3",
        sm: "min-h-9 gap-1.5 px-3 text-[0.8125rem] [&_svg:not([class*='size-'])]:size-3.5",
        lg: "min-h-12 px-6 text-[0.9375rem]",
        icon: "size-11",
        "icon-xs": "size-7 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-9",
        "icon-lg": "size-12",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
