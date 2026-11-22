import { BudgetTool } from '@/components/tools/budget/budget';

export const metadata = { title: 'আয়-ব্যয়ের হিসাব — SocialHub' };

export default function BudgetPage(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-[900px]">
      <BudgetTool />
    </div>
  );
}
