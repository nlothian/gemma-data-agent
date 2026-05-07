import type { TourStage } from '../types';

const PLOT_CODE = `import numpy as np
import matplotlib.pyplot as plt

t = np.linspace(0, 6 * np.pi, 400)
fig = plt.figure()
ax = fig.add_subplot(111, projection='3d')
ax.plot(t, np.sin(t), np.cos(t), label='(t, sin t, cos t)')
ax.set_title('Sine vs Cosine — 3D helix')
ax.set_xlabel('t')
ax.set_ylabel('sin(t)')
ax.set_zlabel('cos(t)')
ax.legend()
plt.show()
`;

const pythonPlot: TourStage = {
  id: 'python-plot',
  markdown:
    "Python runs entirely in your browser via Pyodide — your code never leaves the page. We'll drop in a 3D Sine vs Cosine plot and press **Run**.",
  cutouts: ['exec.codeEditor', 'exec.runButton'],
  onEnter: [
    { action: 'toggleFeatureSelector', params: { open: false } },
    { action: 'setPythonCode', params: { code: PLOT_CODE }, delayMs: 300 },
  ],
  onExit: [
    { action: 'pressRunButton' },
    { action: 'waitForPythonIdle', params: {} },
  ],
  next: 'manual',
};

export default pythonPlot;
