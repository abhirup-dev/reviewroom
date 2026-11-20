// The workbench composition. The standalone player uses the same app context with only its code service.
import { ReviewApp as App } from './app-core';
import { Commands } from './kernel/commands';
import { Layouts } from './kernel/layouts/layout';
import { presentationFor, type Presentation } from './kernel/presentation';
import { createReviewServices } from './services';

export type { AppEvents, Prefs } from './app-core';

export class ReviewApp extends App {
  constructor(root: HTMLElement, createServices = createReviewServices, presentation: Presentation = presentationFor('desktop')) {
    super(root, createServices, presentation);
    this.workbench = { commands: new Commands(), layout: new Layouts(this) };
  }
}
