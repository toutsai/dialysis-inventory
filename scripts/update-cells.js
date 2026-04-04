const fs = require('fs');
let content = fs.readFileSync('src/app/features/stats/stats.component.html', 'utf8');

const regex = /<div class="patient-line-one">\{\{\s*patient\.dialysisBed\s*\}\}\s*-\s*\{\{\s*patient\.name\s*\}\}<\/div>\s*<div class="patient-line-two">\s*<span \*ngIf="patient\.wardNumber" class="ward-number-display">\{\{\s*patient\.wardNumber\s*\}\}<\/span>\s*<span \*ngIf="patient\.mode && patient\.mode !== 'HD'" class="stats-special-mode">\(\{\{\s*patient\.mode\s*\}\}\)<\/span>\s*<span \*ngIf="patient\.finalTags" class="note-display">\{\{\s*patient\.finalTags\s*\}\}<\/span>\s*<\/div>\s*<\/div>\s*<app-patient-messages-icon \[patientId\]="patient\.id" \[messageTypes\]="patient\.messageTypes" context="dialog" \(iconClick\)="handleIconClick\(\$event\)"><\/app-patient-messages-icon>/g;

const replacement = `<div class="patient-line-one">
                        <span class="patient-name-text">{{ patient.dialysisBed }} - {{ patient.name }}</span>
                        <span class="patient-icon-wrapper" (click)="$event.stopPropagation()">
                          <app-patient-messages-icon [patientId]="patient.id" [messageTypes]="patient.messageTypes" context="dialog" (iconClick)="handleIconClick($event)"></app-patient-messages-icon>
                        </span>
                      </div>
                      <div class="patient-line-two">
                        <span *ngIf="patient.wardNumber" class="ward-number-display">{{ patient.wardNumber }}</span>
                        <span *ngIf="patient.mode && patient.mode !== 'HD'" class="stats-special-mode">({{ patient.mode }})</span>
                        <span *ngIf="patient.finalTags" class="note-display">{{ patient.finalTags }}</span>
                      </div>
                    </div>`;

const matches = content.match(regex);
console.log('Found matches:', matches ? matches.length : 0);
content = content.replace(regex, replacement);
fs.writeFileSync('src/app/features/stats/stats.component.html', content);
