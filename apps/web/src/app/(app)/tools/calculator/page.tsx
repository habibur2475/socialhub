import { CalculatorTool } from '@/components/tools/calculator/calculator';

export const metadata = { title: 'Calculator — SocialHub' };

export default function CalculatorPage(): React.JSX.Element {
  return (
    <div className="mx-auto max-w-[900px]">
      <CalculatorTool />
    </div>
  );
}
