"use client"

import { createSupabaseBrowserClient } from "@/lib/supabase/browser"

/** Minimal client-side auth surface backed by Supabase Auth. */
export const authClient = {
  async signOut() {
    const supabase = createSupabaseBrowserClient()
    await supabase.auth.signOut()
  },
}
