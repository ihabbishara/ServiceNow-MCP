---
name: Orange Direct
colors:
  surface: '#fbf9f8'
  surface-dim: '#dcd9d9'
  surface-bright: '#fbf9f8'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f6f3f2'
  surface-container: '#f0eded'
  surface-container-high: '#eae8e7'
  surface-container-highest: '#e4e2e1'
  on-surface: '#1b1c1c'
  on-surface-variant: '#5a4137'
  inverse-surface: '#303030'
  inverse-on-surface: '#f3f0f0'
  outline: '#8f7065'
  outline-variant: '#e3bfb1'
  surface-tint: '#a53d00'
  primary: '#a53d00'
  on-primary: '#ffffff'
  primary-container: '#ff6200'
  on-primary-container: '#541b00'
  inverse-primary: '#ffb597'
  secondary: '#57569f'
  on-secondary: '#ffffff'
  secondary-container: '#b0aefe'
  on-secondary-container: '#403f86'
  tertiary: '#0061a2'
  on-tertiary: '#ffffff'
  tertiary-container: '#009afc'
  on-tertiary-container: '#003053'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  success: '#386a20'
  on-success: '#ffffff'
  success-container: '#b7f397'
  on-success-container: '#042100'
  primary-fixed: '#ffdbcd'
  primary-fixed-dim: '#ffb597'
  on-primary-fixed: '#360f00'
  on-primary-fixed-variant: '#7e2c00'
  secondary-fixed: '#e2dfff'
  secondary-fixed-dim: '#c2c1ff'
  on-secondary-fixed: '#120d58'
  on-secondary-fixed-variant: '#3f3e85'
  tertiary-fixed: '#d1e4ff'
  tertiary-fixed-dim: '#9dcaff'
  on-tertiary-fixed: '#001d35'
  on-tertiary-fixed-variant: '#00497c'
  background: '#fbf9f8'
  on-background: '#1b1c1c'
  surface-variant: '#e4e2e1'
  surface-gray: '#F0F0F0'
  pure-white: '#FFFFFF'
  deep-indigo: '#525199'
typography:
  display-lg:
    fontFamily: Hanken Grotesk
    fontSize: 48px
    fontWeight: '700'
    lineHeight: 56px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Hanken Grotesk
    fontSize: 32px
    fontWeight: '700'
    lineHeight: 40px
  headline-lg-mobile:
    fontFamily: Hanken Grotesk
    fontSize: 28px
    fontWeight: '700'
    lineHeight: 36px
  headline-md:
    fontFamily: Hanken Grotesk
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
  body-lg:
    fontFamily: Hanken Grotesk
    fontSize: 18px
    fontWeight: '400'
    lineHeight: 28px
  body-md:
    fontFamily: Hanken Grotesk
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
  label-md:
    fontFamily: Hanken Grotesk
    fontSize: 14px
    fontWeight: '600'
    lineHeight: 20px
    letterSpacing: 0.01em
  label-sm:
    fontFamily: Hanken Grotesk
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
rounded:
  sm: 0.125rem
  DEFAULT: 0.25rem
  md: 0.375rem
  lg: 0.5rem
  xl: 0.75rem
  full: 9999px
spacing:
  base: 8px
  container-max: 1200px
  gutter: 24px
  margin-mobile: 16px
  margin-desktop: 40px
---

## Brand & Style

This design system embodies a **Corporate Modern** aesthetic characterized by clarity, reliability, and a distinctively optimistic energy. It is designed for a target audience that values efficiency and institutional stability but expects a contemporary, digital-first interaction model.

The style prioritizes high legibility and a systematic "clear-path" approach to navigation. By utilizing a "White-Label" base with strategic injections of high-energy orange, the UI feels both professional and approachable. The design movement leans into **Minimalism** with a focus on generous whitespace and purposeful color usage, ensuring that complex financial data remains digestible and stress-free.

## Colors

The palette is anchored by a signature vibrant orange, used exclusively for primary actions and brand identifiers to maintain high visibility. 

- **Primary (Orange):** Reserved for Call-to-Actions (CTAs), progress indicators, and the brand lion.
- **Secondary (Indigo):** Used for secondary interactive elements or to distinguish specific product categories (e.g., investment or insurance).
- **Neutral:** A deep graphite (#333333) is used for typography to ensure softer contrast than pure black, reducing eye strain.
- **Surface:** A very light gray (#F0F0F0) provides subtle containment for cards and sections against the pure white background.

## Typography

The typography system utilizes **Hanken Grotesk** as a high-quality substitute for proprietary brand fonts, offering a clean, sharp, and contemporary feel that scales perfectly from mobile apps to desktop dashboards.

Headlines should use heavier weights (600-700) to establish a clear hierarchy. Body text is set with generous line heights to facilitate long-form reading of terms, conditions, and financial statements. Use tighter letter spacing for large display titles to give them a premium, editorial feel.

## Layout & Spacing

This design system employs a **Fixed Grid** model for desktop to ensure a consistent reading experience, while transitioning to a **Fluid Grid** for mobile devices.

- **Desktop:** A 12-column grid with a maximum width of 1200px.
- **Mobile:** A 4-column grid with 16px side margins.
- **Rhythm:** An 8px base unit governs all padding and margin decisions. Component internal padding should typically follow increments of 8px (e.g., 16px, 24px) to maintain a rigorous mathematical harmony across the interface.

## Elevation & Depth

Visual hierarchy is achieved primarily through **Tonal Layers** and **Low-contrast outlines**. 

Avoid heavy, dark shadows. Instead, use a single level of elevation for "floating" elements like modals or dropdowns using a very soft, diffused ambient shadow (Alpha 5-8%). For standard UI cards, use a 1px border in a slightly darker shade than the background (e.g., #E0E0E0) rather than a shadow. This creates a flat, "structured" look that feels organized and professional.

## Shapes

The shape language is **Soft (0.25rem)**. This subtle rounding avoids the aggression of sharp corners while maintaining the professional rigor expected of a financial institution. 

Buttons and input fields should strictly adhere to the base roundedness. Larger containers like cards may utilize `rounded-lg` (0.5rem) to provide a softer containment feel. "Pill" shapes are reserved exclusively for status tags (e.g., "Paid," "Pending") to differentiate them from interactive buttons.

## Components

- **Buttons:** Primary buttons are solid Orange (#FF6200) with white text. Secondary buttons use a transparent background with an Orange border and text.
- **Input Fields:** Use a 1px border in a neutral gray. On focus, the border transitions to Orange with a subtle 2px outer glow in a semi-transparent orange.
- **Cards:** Cards should have a white background, no shadow, and a 1px #F0F0F0 border. On hover, the border may darken slightly to indicate interactivity.
- **Chips/Tags:** Used for filtering or status. Use Indigo (#525199) backgrounds for informational tags and light gray for inactive filters.
- **Progress Bars:** Use the primary Orange for the "filled" state to signify movement and brand presence.
- **Lists:** Transaction lists should be high-density with clear dividers, using `label-md` for amounts and `body-md` for descriptions.