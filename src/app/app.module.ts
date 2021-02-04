import { BrowserModule } from '@angular/platform-browser';
import { NgModule } from '@angular/core';
import { BrowserAnimationsModule } from '@angular/platform-browser/animations';

import { AppComponent } from './app.component';
import { TestLibModule } from 'projects/test-lib/src/public-api';
import { NgxChatModule } from 'projects/ngx-chat/src/public-api';

@NgModule({
  declarations: [
    AppComponent
  ],
  imports: [
	  BrowserModule, BrowserAnimationsModule,
	  TestLibModule,
	  NgxChatModule.forRoot(),
  ],
  providers: [],
  bootstrap: [AppComponent]
})
export class AppModule { }
