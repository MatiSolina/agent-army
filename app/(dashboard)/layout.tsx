import { redirect } from "next/navigation"
import { getSessionUser } from "@/lib/session"
import { Sidebar } from "@/components/dashboard/sidebar"

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Access gate: must be signed in (Better Auth). Data stays under demo-user.
  const user = await getSessionUser()
  if (!user) redirect("/sign-in")

  return (
    // Block (not flex): a flex row gave the content wrapper `min-width:auto`,
    // which let wide children push it past the viewport (mobile sideways scroll),
    // and made the mobile-topbar spacer collapse to zero height (navbar overlap).
    // overflow-x-clip is a belt-and-suspenders guard against any wide child.
    <div className="min-h-svh overflow-x-clip bg-background md:pl-[70px]">
      <Sidebar userName={user.name} userEmail={user.email} />
      {/* pt-20 clears the fixed mobile top bar (~4rem) + breathing room. */}
      <main className="mx-auto w-full max-w-6xl px-5 pb-10 pt-20 md:px-10 md:py-14">
        {children}
      </main>
    </div>
  )
}
